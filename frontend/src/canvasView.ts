export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 12;

const zoomSteps = [MIN_ZOOM, 0.1, 0.125, 0.25, 0.5, 0.75, ...Array.from({ length: MAX_ZOOM }, (_, index) => index + 1)];
const descendingSteps = [...zoomSteps].reverse();

export function stepZoom(zoom: number, direction: number) {
  return direction > 0
    ? zoomSteps.find(value => value > zoom + 0.0001) ?? MAX_ZOOM
    : descendingSteps.find(value => value < zoom - 0.0001) ?? MIN_ZOOM;
}
