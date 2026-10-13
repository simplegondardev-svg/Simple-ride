"use client";

import {
  Map as MlMap, Marker, NavigationControl, setWorkerUrl,
  type GeoJSONSource, type MapMouseEvent, type StyleSpecification,
} from "maplibre-gl";
import { useEffect, useRef } from "react";

export interface LatLng { lat: number; lng: number }

const ADDIS: [number, number] = [38.7578, 9.0054];

/**
 * Gebeta vector tiles when NEXT_PUBLIC_GEBETA_TILES_KEY is set. Gebeta
 * authenticates tile, sprite and font requests with a Bearer header, added
 * here via transformRequest exactly as the official @gebeta/tiles package does.
 * Without a key, an OpenStreetMap raster style keeps local dev working
 * (OSM's public tiles are for development only — not production traffic).
 *
 * The key is visible to anyone using the site. Use a key restricted to your
 * domain in the Gebeta dashboard; the stronger option is short-lived tokens
 * minted by the API with @gebeta/node (see docs/ARCHITECTURE.md).
 */
const GEBETA_KEY = process.env.NEXT_PUBLIC_GEBETA_TILES_KEY;

// Copied into public/ by scripts/copy-maplibre-worker.mjs (pre-dev/pre-build).
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
const GEBETA_STYLE = "https://tiles.gebeta.app/styles/standard/style.json";

const OSM_STYLE: StyleSpecification = {
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

/**
 * Gebeta's style references "Open Sans" fonts its server doesn't host (404),
 * which hides square and office labels — squares like Meskel Square are key
 * landmarks for riders. Swap them for the font Gebeta does serve.
 */
const HOSTED_FONT = "JakartaSans";
function fixGebetaFonts(_prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
  return {
    ...next,
    layers: next.layers.map((layer) => {
      const font = layer.type === "symbol" ? layer.layout?.["text-font"] : undefined;
      if (!Array.isArray(font) || !font.some((f) => typeof f === "string" && f.startsWith("Open Sans"))) return layer;
      return { ...layer, layout: { ...layer.layout, "text-font": [HOSTED_FONT] } } as typeof layer;
    }),
  };
}

const transformRequest = (url: string) =>
  GEBETA_KEY && new URL(url).hostname === "tiles.gebeta.app"
    ? { url, headers: { Authorization: `Bearer ${GEBETA_KEY}` } }
    : { url };

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
    const m = new MlMap({ container: el.current, center: ADDIS, zoom: 12, transformRequest });
    if (GEBETA_KEY) m.setStyle(GEBETA_STYLE, { transformStyle: fixGebetaFonts });
    else m.setStyle(OSM_STYLE);
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
