"use client";

import {
  Map as MlMap, Marker, NavigationControl, type GeoJSONSource, type MapMouseEvent, type StyleSpecification,
} from "maplibre-gl";
import { useEffect, useRef } from "react";

export interface LatLng { lat: number; lng: number }

const ADDIS: [number, number] = [38.7578, 9.0054];

/**
 * Gebeta vector tiles when NEXT_PUBLIC_GEBETA_STYLE_URL is set; otherwise an
 * OpenStreetMap raster style so the app works before a key is configured.
 * (OSM's public tiles are for development only — not production traffic.)
 */
const style: string | StyleSpecification = process.env.NEXT_PUBLIC_GEBETA_STYLE_URL || {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export function RideMap(props: {
  pickup?: LatLng;
  dropoff?: LatLng;
  driver?: LatLng;
  /** GeoJSON-order [lng, lat] route */
  path?: [number, number][];
  onPick?: (p: LatLng) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const onPick = useRef(props.onPick);
  onPick.current = props.onPick;

  useEffect(() => {
    if (!el.current) return;
    const m = new MlMap({ container: el.current, style, center: ADDIS, zoom: 12 });
    m.addControl(new NavigationControl(), "top-right");
    m.on("click", (e: MapMouseEvent) => onPick.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    map.current = m;
    return () => m.remove();
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    markers.current.forEach((mk) => mk.remove());
    markers.current = [];
    const add = (p: LatLng | undefined, color: string) => {
      if (p) markers.current.push(new Marker({ color }).setLngLat([p.lng, p.lat]).addTo(m));
    };
    add(props.pickup, "#0f7a4a");
    add(props.dropoff, "#b42318");
    add(props.driver, "#1d4ed8");

    const draw = () => {
      const data = {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "LineString" as const, coordinates: props.path ?? [] },
      };
      const src = m.getSource("route") as GeoJSONSource | undefined;
      if (src) src.setData(data);
      else {
        m.addSource("route", { type: "geojson", data });
        m.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#0f7a4a", "line-width": 4 } });
      }
    };
    if (m.isStyleLoaded()) draw();
    else m.once("load", draw);
  }, [props.pickup, props.dropoff, props.driver, props.path]);

  return <div ref={el} className="map" role="application" aria-label="Map" />;
}
