// Zooming a chart along its x axis: the wheel, the box, the drag and the pinch. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boxView, clampView, dragView, extent, indexWindow, isDoubleTap, isZoomed, nearestIndex, panBy, pinchView,
  pixelOf, shownRange, valueAt, wheelFactor, zoomAround,
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
