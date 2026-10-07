// Zooming a chart along its x axis: the wheel, the box, the drag and the pinch. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boxPlane, boxView, clampPlane, clampView, dragPlane, dragView, extent, fromFrame, indexWindow, isDoubleTap, isZoomed,
  nearestIndex, panBy, pinchPlane, pinchView, pixelOf, shownRange, toFrame, valueAt, wheelFactor, zoomAround,
  zoomPlaneAt,
} from './zoom.ts';

const LAP = [0, 4500]; // a lap of 4.5 km
const near = (a, b, msg) => {
  assert.ok(a && b, msg);
  assert.ok(Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6, `${msg}: ${a} != ${b}`);
};

test('a view is kept inside the lap and no narrower than a hundredth of it', () => {
  near(clampView([-100, 400], LAP), [0, 500], 'slid back in from the start');
  near(clampView([4300, 4700], LAP), [4100, 4500], 'slid back in from the end');
  near(clampView([1000, 1010], LAP), [982.5, 1027.5], 'widened to 45 m about its middle');
  near(clampView([2000, 1000], LAP), [1000, 2000], 'ends in either order');
  assert.equal(clampView([-10, 4600], LAP), null, 'the whole lap is no zoom');
  assert.equal(clampView([0, 4500], LAP), null);
  near(clampView([1000, 1010], LAP, 100), [955, 1055], 'a chart can ask for a wider least span');
  assert.equal(clampView([0, 1], [5, 5]), null, 'an axis with no length cannot zoom');
});

test('the range shown is the zoom within each chart\'s own axis, or the whole axis', () => {
  near(shownRange(null, LAP), LAP, 'no zoom');
  near(shownRange([1000, 2000], LAP), [1000, 2000], 'zoomed');
  near(shownRange([4000, 4600], [0, 4400]), [3800, 4400], 'a shorter lap in the same group keeps the span');
  assert.equal(isZoomed(null, LAP), false);
  assert.equal(isZoomed([0, 4500], LAP), false);
  assert.equal(isZoomed([0, 4000], LAP), true);
});

test('pixels and values map both ways', () => {
  const view = [1000, 2000];
  assert.equal(valueAt(40, view, 40, 500), 1000);
  assert.equal(valueAt(540, view, 40, 500), 2000);
  assert.equal(pixelOf(1500, view, 40, 500), 290);
  assert.equal(valueAt(pixelOf(1234, view, 40, 500), view, 40, 500), 1234);
});

test('the wheel zooms about the pointer: the value under it stays under it', () => {
  const view = zoomAround(LAP, LAP, 900, 0.5);
  near(view, [450, 2700], 'half the span, 900 m still a fifth of the way across');
  assert.ok(wheelFactor(-100) < 1 && wheelFactor(100) > 1, 'scrolling up zooms in');
  assert.ok(Math.abs(wheelFactor(-100) * wheelFactor(100) - 1) < 1e-9, 'in and out by the same notch cancel');
  assert.ok(wheelFactor(-3, 1) < wheelFactor(-3, 0), 'line steps count as more than pixels');
  assert.ok(wheelFactor(-5, 0, true) < wheelFactor(-5, 0), 'a trackpad pinch zooms faster per pixel');
  assert.equal(zoomAround([1000, 2000], LAP, 1500, 10), null, 'zooming far out comes back to the whole lap');
  near(zoomAround([1000, 1045], LAP, 1020, 0.5), [1000, 1045], 'at the narrowest a zoom in stays put');
  near(zoomAround([0, 1000], LAP, 0, 0.5), [0, 500], 'anchored at the start');
});

test('a drag pans by the pixels moved and stops at the ends', () => {
  near(dragView([1000, 2000], LAP, -100, 500), [1200, 2200], 'dragging left shows what is further on');
  near(dragView([1000, 2000], LAP, 5000, 500), [0, 1000], 'stops at the start');
  near(panBy([3000, 4000], LAP, 900), [3500, 4500], 'stops at the end');
});

test('a dragged box zooms into what it covers', () => {
  near(boxView(LAP, LAP, 140, 240, 40, 500), [900, 1800], 'the box\'s ends, as values');
  near(boxView(LAP, LAP, 240, 140, 40, 500), [900, 1800], 'dragged right to left');
  assert.equal(boxView(LAP, LAP, 140, 143, 40, 500), null, 'a click is not a box');
  near(boxView(LAP, LAP, 0, 140, 40, 500), [0, 900], 'kept inside the plot');
});

test('a pinch spreads the view about the point between the fingers', () => {
  // fingers 100 px apart at 190..290 (1350..2250 m) spread to 200 px apart about the same middle
  near(pinchView(LAP, LAP, [190, 290], [140, 340], 40, 500), [900, 3150], 'twice as close');
  // the same spread, moved 50 px left: the middle value follows the fingers
  const moved = pinchView(LAP, LAP, [190, 290], [90, 290], 40, 500);
  assert.ok(Math.abs(valueAt(190, moved, 40, 500) - 1800) < 1e-6, 'the value between the fingers is under them');
  near(pinchView([1000, 2000], LAP, [190, 390], [240, 340], 40, 500), [500, 2500], 'pinching in zooms out');
  assert.equal(pinchView([1000, 2000], LAP, [200, 300], [270, 290], 40, 500), null, 'all the way out is the whole lap');
  near(pinchView([1000, 2000], LAP, [200, 205], [250, 255], 40, 500), [900, 1900], 'fingers together only pan');
});

test('the points that draw a view: those inside it and one either side', () => {
  const xs = [0, 10, 20, 30, 40, 50];
  assert.deepEqual(indexWindow(xs, [0, 50]), [0, 5]);
  assert.deepEqual(indexWindow(xs, [15, 32]), [1, 4]);
  assert.deepEqual(indexWindow(xs, [20, 30]), [1, 4]);
  assert.deepEqual(indexWindow([], [0, 1]), [0, -1]);
  assert.equal(nearestIndex(xs, 14), 1);
  assert.equal(nearestIndex(xs, 16), 2);
  assert.equal(nearestIndex(xs, -5), 0);
  assert.equal(nearestIndex(xs, 99), 5);
});

test('the y axis fits the points shown, gaps left out', () => {
  assert.deepEqual(extent([[5, 1, 9, 3], [4, 2, NaN, 8]], 1, 2), [1, 9]);
  assert.deepEqual(extent([[5, 1, 9, 3], [4, 2, NaN, 8]], 2, 3), [3, 9]);
  assert.equal(extent([[NaN, NaN]], 0, 1), null);
  assert.deepEqual(extent([[1, 2]], 0, 10), [1, 2], 'past the end is left out');
});

test('a double tap is two taps close in time and place', () => {
  assert.equal(isDoubleTap(null, 1000, 50), false);
  assert.equal(isDoubleTap({ t: 1000, x: 50 }, 1200, 60), true);
  assert.equal(isDoubleTap({ t: 1000, x: 50 }, 1500, 60), false);
  assert.equal(isDoubleTap({ t: 1000, x: 50 }, 1200, 120), false);
});

test('the y axis fits the points shown, over the gaps in a series', () => {
  near(extent([[1, null, 5, NaN, 3]], 0, 4), [1, 5], 'null and NaN are gaps');
  assert.equal(extent([[null, null]], 0, 1), null, 'nothing to fit');
});

// a map drawn 300 by 200 px
const W = 300, H = 200;
const nearPt = (a, b, msg) => assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6,
  `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

test('a map zooms both ways about the pointer and keeps its shape', () => {
  const v = zoomPlaneAt(null, W, H, { x: 60, y: 50 }, 0.5);
  assert.equal(v.k, 2, 'twice as close');
  nearPt(toFrame(v, W, H, { x: 60, y: 50 }), { x: 60, y: 50 }, 'the point under the pointer stays there');
  nearPt(fromFrame(v, W, H, toFrame(v, W, H, { x: 123, y: 45 })), { x: 123, y: 45 }, 'there and back');
  assert.equal(zoomPlaneAt(v, W, H, { x: 60, y: 50 }, 4), null, 'zoomed out past the whole map: no zoom');
  assert.equal(zoomPlaneAt(null, W, H, { x: 10, y: 10 }, 0.001).k, 12, 'no closer than 12 times');
});

test('a zoomed map keeps the frame on the drawing', () => {
  const v = clampPlane({ k: 2, cx: 0, cy: 1000 }, W, H);
  assert.deepEqual(v, { k: 2, cx: 75, cy: 150 }, 'slid back so the frame shows only the drawing');
  assert.equal(clampPlane({ k: 1, cx: 10, cy: 10 }, W, H), null, 'the whole map is no zoom');
  assert.equal(clampPlane({ k: 0.5, cx: 10, cy: 10 }, W, H), null);
});

test('a drag slides a zoomed map with the finger, both ways', () => {
  const v = { k: 4, cx: 150, cy: 100 };
  assert.deepEqual(dragPlane(v, W, H, 40, -20), { k: 4, cx: 140, cy: 105 });
  assert.equal(dragPlane(null, W, H, 40, -20), null, 'nothing to slide on the whole map');
});

test('a box zooms the map to fit it, keeping its shape', () => {
  const v = boxPlane(null, W, H, { x: 100, y: 50 }, { x: 160, y: 70 });
  assert.equal(v.k, 5, 'the wide box fits across: 300 / 60');
  nearPt({ x: v.cx, y: v.cy }, { x: 130, y: 60 }, 'centred on the box');
  assert.equal(boxPlane(null, W, H, { x: 100, y: 50 }, { x: 103, y: 52 }), null, 'a click is no box');
});

test('a pinch keeps the point between the fingers between them', () => {
  const v = pinchPlane(null, W, H, [{ x: 100, y: 100 }, { x: 140, y: 100 }], [{ x: 80, y: 100 }, { x: 160, y: 100 }]);
  assert.equal(v.k, 2, 'fingers twice as far apart');
  nearPt(toFrame(v, W, H, { x: 120, y: 100 }), { x: 120, y: 100 }, 'the middle stays');
  const moved = pinchPlane(v, W, H, [{ x: 100, y: 100 }, { x: 140, y: 100 }], [{ x: 110, y: 110 }, { x: 150, y: 110 }]);
  assert.equal(moved.k, 2, 'the same spread: no zoom');
  nearPt(toFrame(moved, W, H, fromFrame(v, W, H, { x: 120, y: 100 })), { x: 130, y: 110 }, 'and it pans with them');
});
