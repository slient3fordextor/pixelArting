import base64
import json
import threading
import time

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.ai import AiProviderError, OpenAICompatibleProvider
from backend.ai_candidates import _image_bytes, _pixelate
from backend.app import create_app
from backend.images import decode_image, png_bytes
from backend.models import AiGenerationRequest, AiProviderConfig
from backend.store import Conflict, GenerationQueueFull, Store


KEY = "sk-private-test-only"


def drawing_result():
    return {
        "kind": "drawing_commands", "provider": "openai-compatible", "model": "text-test", "calledExternally": True,
        "candidates": [{"id": "candidate_1", "summary": "红色图标", "commands": [
            {"tool": "create_canvas", "args": {"width": 8, "height": 8}},
            {"tool": "draw_rect", "args": {"x": 2, "y": 2, "width": 4, "height": 4, "color": "#FF0000"}},
        ]}],
    }


class DrawingProvider:
    def __init__(self, config):
        self.config = config

    def generate_text(self, request):
        return drawing_result()


def wait_task(client, generation_id, statuses=("succeeded", "failed", "cancelled")):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = client.get(f"/api/ai/generations/{generation_id}").json()
        if result["status"] in statuses:
            return result
        time.sleep(0.01)
    pytest.fail("AI task did not reach expected status")


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def configure(client, key=KEY):
    response = client.put("/api/ai/config", json={"apiKey": key, "baseUrl": "https://provider.example/v1", "textModel": "text-test", "imageModel": "image-test"})
    assert response.status_code == 200
    return response.json()


def generate(client, project_id=None, mode="agent_draw", **kwargs):
    response = client.post("/api/ai/generations", json={"projectId": project_id, "mode": mode, "prompt": "画一个红色图标", "width": 8, "height": 8, **kwargs})
    assert response.status_code == 202, response.text
    return response.json()


def test_config_key_never_echoed_and_persists_without_env(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-used")
    with TestClient(create_app(tmp_path)) as client:
        default = client.get("/api/ai/config").json()
        assert default["hasApiKey"] is False
        assert "apiKey" not in default
        saved = configure(client)
        assert saved["hasApiKey"] is True
        assert KEY not in json.dumps(saved)
        assert "apiKey" not in saved
        updated = client.put("/api/ai/config", json={"textModel": "changed", "apiKey": ""}).json()
        assert updated["hasApiKey"] is True
        assert client.app.state.store.ai_config().apiKey == KEY
        assert tmp_path.joinpath("pixelart.sqlite3").stat().st_mode & 0o777 == 0o600
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/ai/config").json()["textModel"] == "changed"
        assert client.get("/api/ai/config").json()["hasApiKey"] is True
        assert client.put("/api/ai/config", json={"clearApiKey": True}).json()["hasApiKey"] is False


@pytest.mark.parametrize("body", [
    {"apiKey": KEY * 500}, {"apiKey": {"secret": KEY}},
    {"apiKey": KEY, "baseUrl": "https://user:password@provider.example/v1"},
    {"apiKey": KEY, "baseUrl": "file:///tmp/data"},
    {"apiKey": KEY, "imageSize": "4096x4096"},
    {"apiKey": KEY, "textModel": "   "},
])
def test_invalid_config_errors_are_redacted(client, body):
    response = client.put("/api/ai/config", json=body)
    assert response.status_code == 422
    assert KEY not in response.text
    assert "input" not in response.text


def test_unconfigured_api_rejects_no_fake_generation(client):
    response = client.post("/api/ai/generations", json={"mode": "agent_draw", "prompt": "图标"})
    assert response.status_code == 409
    assert client.get("/api/ai/generations").json() == []


def test_drawing_generation_preview_select_and_idempotence(client):
    configure(client)
    client.app.state.ai_provider_factory = DrawingProvider
    project = client.post("/api/projects", json={"name": "AI 测试"}).json()
    queued = generate(client, project["id"])
    assert queued["status"] == "queued"
    task = wait_task(client, queued["id"])
    assert task["status"] == "succeeded", task
    assert KEY not in json.dumps(task)
    candidate = task["result"]["candidates"][0]
    preview = decode_image(candidate["image"])
    assert preview.size == (8, 8)
    assert preview.getpixel((2, 2)) == (255, 0, 0, 255)
    assert client.get(f'/api/projects/{project["id"]}/assets').json() == []
    selection = {"candidateId": "candidate_1", "name": "AI 图标"}
    first = client.post(f'/api/ai/generations/{queued["id"]}/select', json=selection)
    assert first.status_code == 201, first.text
    asset = first.json()["asset"]
    assert asset["name"] == "AI 图标"
    assert asset["versions"][0]["operation"] == "ai-import"
    assert asset["document"]["provenance"]["generationId"] == queued["id"]
    second = client.post(f'/api/ai/generations/{queued["id"]}/select', json=selection).json()["asset"]
    assert second["id"] == asset["id"]
    assert len(client.get(f'/api/projects/{project["id"]}/assets').json()) == 1
    assert client.post(f'/api/ai/generations/{queued["id"]}/select', json={"candidateId": "missing"}).status_code == 404
    assert client.get("/api/ai/generations", params={"projectId": project["id"], "status": "succeeded"}).json()[0]["id"] == queued["id"]


def test_cancelled_task_discards_late_result_and_retry(client):
    configure(client)
    started, release = threading.Event(), threading.Event()

    class SlowProvider(DrawingProvider):
        def generate_text(self, request):
            started.set()
            assert release.wait(5)
            return drawing_result()

    client.app.state.ai_provider_factory = SlowProvider
    queued = generate(client)
    try:
        assert started.wait(2)
        assert client.post(f'/api/ai/generations/{queued["id"]}/retry').status_code == 409
        cancelled = client.post(f'/api/ai/generations/{queued["id"]}/cancel')
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] == "cancelled"
    finally:
        release.set()
    client.app.state.ai_provider_factory = DrawingProvider
    retry = client.post(f'/api/ai/generations/{queued["id"]}/retry')
    assert retry.status_code == 202
    assert retry.json()["id"] != queued["id"]
    assert wait_task(client, retry.json()["id"])["status"] == "succeeded"
    time.sleep(0.02)
    assert client.get(f'/api/ai/generations/{queued["id"]}').json()["status"] == "cancelled"
    assert client.get(f'/api/ai/generations/{queued["id"]}').json()["result"] is None


def test_failed_provider_cannot_leak_key(client):
    configure(client)

    class BrokenProvider(DrawingProvider):
        def generate_text(self, request):
            raise AiProviderError("error contains " + KEY)

    client.app.state.ai_provider_factory = BrokenProvider
    task = wait_task(client, generate(client)["id"])
    assert task["status"] == "failed"
    assert KEY not in json.dumps(task)


@pytest.mark.parametrize("key", [KEY, 'sk-test"x', "sk-test\\path"])
def test_result_cannot_leak_key(client, key):
    configure(client, key)

    class LeakyProvider(DrawingProvider):
        def generate_text(self, request):
            result = drawing_result()
            result["candidates"][0]["summary"] = key
            return result

    client.app.state.ai_provider_factory = LeakyProvider
    task = wait_task(client, generate(client)["id"])
    assert task["status"] == "failed"
    assert key not in json.dumps(task)
    assert task["result"] is None


def test_image_candidate_preserves_source_and_pixelates(client):
    configure(client)
    image = Image.new("RGBA", (16, 16), (255, 0, 0, 200))
    image.putpixel((0, 0), (0, 0, 0, 0))

    class ImageProvider(DrawingProvider):
        def generate_image(self, request):
            return {"kind": "image_candidates", "provider": "openai-compatible", "model": "image-test", "calledExternally": True, "candidates": [{"id": "candidate_1", "b64Json": base64.b64encode(png_bytes(image)).decode()}]}

    client.app.state.ai_provider_factory = ImageProvider
    project = client.post("/api/projects", json={"name": "图片"}).json()
    task = wait_task(client, generate(client, project["id"], mode="image_model", paletteLimit=2)["id"])
    assert task["status"] == "succeeded", task
    candidate = task["result"]["candidates"][0]
    assert "b64Json" not in candidate
    assert "url" not in candidate
    assert candidate["source"]["width"] == 16
    preview = decode_image(candidate["image"])
    assert preview.size == (8, 8)
    assert set(np.array(preview)[:, :, 3].flatten()) <= {0, 255}
    assert len(preview.getcolors()) <= 3
    source = client.get(f'/api/ai/generations/{task["id"]}/candidates/candidate_1/source')
    assert source.status_code == 200
    assert source.content == png_bytes(image)
    selected = client.post(f'/api/ai/generations/{task["id"]}/select', json={"candidateId": "candidate_1"})
    assert selected.status_code == 201
    assert selected.json()["asset"]["document"]["provenance"]["originalRef"] == candidate["source"]["originalRef"]


def test_restart_fails_interrupted_tasks_and_queue_is_bounded(tmp_path):
    store = Store(tmp_path)
    request = AiGenerationRequest(mode="agent_draw", prompt="图标")
    queued = store.create_generation(request)
    running = store.create_generation(request)
    store.update_generation(running.id, "running")
    for _ in range(30):
        store.create_generation(request)
    with pytest.raises(GenerationQueueFull):
        store.create_generation(request)
    with TestClient(create_app(tmp_path)) as client:
        assert client.get(f"/api/ai/generations/{queued.id}").json()["status"] == "failed"
        assert client.get(f"/api/ai/generations/{running.id}").json()["status"] == "failed"
        assert "重启" in client.get(f"/api/ai/generations/{running.id}").json()["error"]


def test_openai_compatible_text_payload_and_api_url():
    captured = []

    def handle(request):
        captured.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"candidates": drawing_result()["candidates"]})}}]})

    provider = OpenAICompatibleProvider(AiProviderConfig(baseUrl="https://provider.example/v1", apiKey=KEY, textModel="custom-text"), transport=httpx.MockTransport(handle))
    result = provider.generate_text(AiGenerationRequest(mode="agent_draw", prompt="图标", width=8, height=8))
    assert result["model"] == "custom-text"
    assert captured[0].url.path == "/v1/chat/completions"
    assert captured[0].headers["Authorization"] == "Bearer " + KEY
    payload = json.loads(captured[0].content)
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["max_tokens"] == 8192
    assert "temperature" not in payload


def test_openai_compatible_image_uses_provider_size():
    captured = []

    def handle(request):
        captured.append(request)
        return httpx.Response(200, json={"data": [{"b64_json": "AAAA"}]})

    provider = OpenAICompatibleProvider(AiProviderConfig(baseUrl="https://provider.example/v1", apiKey=KEY, imageModel="custom-image", imageSize="1536x1024"), transport=httpx.MockTransport(handle))
    result = provider.generate_image(AiGenerationRequest(mode="image_model", prompt="图标", width=64, height=64))
    assert result["model"] == "custom-image"
    assert captured[0].url.path == "/v1/images/generations"
    payload = json.loads(captured[0].content)
    assert payload["size"] == "1536x1024"
    assert "background" not in payload


def test_provider_error_body_never_echoes_credentials():
    provider = OpenAICompatibleProvider(AiProviderConfig(apiKey=KEY), transport=httpx.MockTransport(lambda request: httpx.Response(401, json={"error": KEY})))
    with pytest.raises(AiProviderError) as raised:
        provider.generate_image(AiGenerationRequest(mode="image_model", prompt="图标"))
    assert KEY not in str(raised.value)
    assert "HTTP 401" in str(raised.value)


def test_output_token_parameter_is_user_configurable():
    captured = []

    def handle(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"candidates": drawing_result()["candidates"]})}}]})

    provider = OpenAICompatibleProvider(AiProviderConfig(apiKey=KEY, tokenLimitParameter="max_completion_tokens", maxOutputTokens=4096), transport=httpx.MockTransport(handle))
    provider.generate_text(AiGenerationRequest(mode="agent_draw", prompt="图标", width=8, height=8))
    assert captured[0]["max_completion_tokens"] == 4096
    assert "max_tokens" not in captured[0]


def test_provider_response_body_has_real_size_limit(monkeypatch):
    import backend.ai as ai

    monkeypatch.setattr(ai, "MAX_PROVIDER_BYTES", 32)
    provider = OpenAICompatibleProvider(AiProviderConfig(apiKey=KEY), transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"{" + b"x" * 64)))
    with pytest.raises(AiProviderError, match="超过"):
        provider.generate_text(AiGenerationRequest(mode="agent_draw", prompt="图标"))


def test_transparent_pixels_do_not_consume_one_color_palette():
    image = Image.new("RGBA", (8, 8), (255, 255, 255, 0))
    for x in range(4, 8):
        for y in range(8):
            image.putpixel((x, y), (222, 133, 17, 255))
    result = _pixelate(image, AiGenerationRequest(mode="image_model", prompt="图标", width=8, height=8, paletteLimit=1))
    assert result.getpixel((0, 0)) == (0, 0, 0, 0)
    assert result.getpixel((7, 7)) == (222, 133, 17, 255)
    assert {tuple(pixel) for pixel in np.array(result).reshape((-1, 4))} == {(0, 0, 0, 0), (222, 133, 17, 255)}


def test_fully_transparent_and_opaque_images_have_expected_background():
    image = Image.new("RGBA", (8, 8), (255, 0, 0, 0))
    request = AiGenerationRequest(mode="image_model", prompt="图标", width=8, height=8, paletteLimit=1)
    assert np.all(np.array(_pixelate(image, request)) == 0)
    assert np.all(np.array(_pixelate(image, request.model_copy(update={"transparentBackground": False}))) == 255)


def test_downloaded_candidate_does_not_receive_authorization(monkeypatch):
    original_client = httpx.Client
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, content=png_bytes(Image.new("RGBA", (8, 8))))

    monkeypatch.setattr(httpx, "Client", lambda **kwargs: original_client(transport=httpx.MockTransport(handle), **kwargs))
    data = _image_bytes({"url": "https://images.example/signed?token=secret"}, 10)
    assert data.startswith(b"\x89PNG")
    assert "authorization" not in requests[0].headers


def test_downloaded_candidate_rejects_redirects(monkeypatch):
    original_client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: original_client(transport=httpx.MockTransport(lambda request: httpx.Response(302, headers={"Location": "http://internal.example"})), **kwargs))
    with pytest.raises(AiProviderError, match="重定向"):
        _image_bytes({"url": "https://images.example/signed"}, 10)


def test_project_delete_cleans_ai_tasks(client):
    configure(client)
    client.app.state.ai_provider_factory = DrawingProvider
    project = client.post("/api/projects", json={"name": "待删除"}).json()
    task = wait_task(client, generate(client, project["id"])["id"])
    selected = client.post(f'/api/ai/generations/{task["id"]}/select', json={"candidateId": "candidate_1"}).json()["asset"]
    response = client.request("DELETE", f'/api/projects/{project["id"]}', json={"expectedName": project["name"], "expectedCurrentVersions": {selected["id"]: selected["currentVersionId"]}})
    assert response.status_code == 200
    assert client.get(f'/api/ai/generations/{task["id"]}').status_code == 404
    assert client.get("/api/ai/config").json()["hasApiKey"] is True

