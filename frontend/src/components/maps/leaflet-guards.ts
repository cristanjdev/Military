import L from "leaflet";

/**
 * Leaflet 1.9 finishes a zoom animation from a 250 ms timer that `map.remove()` does not cancel.
 * When a map unmounts mid-zoom (the GPS page switching between live view and route history,
 * closing the Locate dialog, leaving a page right after the map framed its markers), that timer
 * runs on the removed map, reads its deleted pane and throws
 * "Cannot read properties of undefined (reading '_leaflet_pos')".
 *
 * A removed map has no `_mapPane`, so there is nothing left to move: skip the work.
 */
type MapInternals = {
  _mapPane?: HTMLElement;
  _animatingZoom?: boolean;
  _onZoomTransitionEnd: (this: MapInternals) => void;
  _getMapPanePos: (this: MapInternals) => L.Point;
  __armoryGuarded?: boolean;
};

const proto = L.Map.prototype as unknown as MapInternals;

if (!proto.__armoryGuarded) {
  proto.__armoryGuarded = true;

  const onZoomTransitionEnd = proto._onZoomTransitionEnd;
  proto._onZoomTransitionEnd = function () {
    if (!this._mapPane) {
      this._animatingZoom = false;
      return;
    }
    onZoomTransitionEnd.call(this);
  };

  const getMapPanePos = proto._getMapPanePos;
  proto._getMapPanePos = function () {
    return this._mapPane ? getMapPanePos.call(this) : new L.Point(0, 0);
  };
}
