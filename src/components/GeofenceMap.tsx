import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface GeofenceMapProps {
  latitude: number;
  longitude: number;
  radius: number;
  onPick?: (lat: number, lng: number) => void;
}

// ── Tile sources ─────────────────────────────────────────────────────────────
// Satellite: Esri World Imagery (free, no API key — same aerial photos style
// as Google satellite view). A transparent "places & boundaries" layer is
// drawn on top so roads/labels stay readable (hybrid look).
// Street: OpenStreetMap (the previous default).
const SAT_URL    = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SAT_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const STREET_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * Geofence preview: satellite imagery (default) or street map, with a
 * marker + radius circle. Tapping the map moves the geofence center
 * (calls onPick). A small button toggles Satellite ⇄ Street view.
 */
export default function GeofenceMap({ latitude, longitude, radius, onPick }: GeofenceMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const baseLayersRef = useRef<L.TileLayer[]>([]);
  const [satellite, setSatellite] = useState(true);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  // Create the map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [latitude || 20, longitude || 78],
      zoom: latitude ? 16 : 4,
      zoomControl: true,
      attributionControl: false,
    });
    map.on('click', (e: L.LeafletMouseEvent) => {
      onPickRef.current?.(
        Math.round(e.latlng.lat * 1e6) / 1e6,
        Math.round(e.latlng.lng * 1e6) / 1e6,
      );
    });
    mapRef.current = map;
    // Leaflet mis-sizes inside animated containers; refresh after paint
    setTimeout(() => map.invalidateSize(), 200);
    return () => { map.remove(); mapRef.current = null; circleRef.current = null; markerRef.current = null; baseLayersRef.current = []; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap base tiles when the Satellite/Street toggle changes (also runs on
  // first render to add the initial layer, since map creation adds none).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    baseLayersRef.current.forEach(l => map.removeLayer(l));
    baseLayersRef.current = [];
    if (satellite) {
      const imagery = L.tileLayer(SAT_URL, { maxZoom: 19, maxNativeZoom: 18 }).addTo(map);
      const labels  = L.tileLayer(SAT_LABELS, { maxZoom: 19, maxNativeZoom: 18 }).addTo(map);
      baseLayersRef.current = [imagery, labels];
    } else {
      const street = L.tileLayer(STREET_URL, { maxZoom: 19 }).addTo(map);
      baseLayersRef.current = [street];
    }
    // Keep marker/circle above the newly added tiles
    markerRef.current?.bringToFront();
    circleRef.current?.bringToFront();
  }, [satellite]);

  // Sync marker + circle whenever inputs change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !latitude || !longitude) return;
    const pos: L.LatLngExpression = [latitude, longitude];

    if (!markerRef.current) {
      markerRef.current = L.circleMarker(pos, {
        radius: 6, color: '#0d9488', fillColor: '#14b8a6', fillOpacity: 1, weight: 2,
      }).addTo(map);
    } else {
      markerRef.current.setLatLng(pos);
    }

    if (!circleRef.current) {
      circleRef.current = L.circle(pos, {
        radius, color: '#0d9488', fillColor: '#14b8a6', fillOpacity: 0.15, weight: 2,
      }).addTo(map);
    } else {
      circleRef.current.setLatLng(pos);
      circleRef.current.setRadius(radius);
    }

    // Keep the whole fence visible
    map.fitBounds(circleRef.current.getBounds(), { padding: [20, 20], maxZoom: 18 });
  }, [latitude, longitude, radius]);

  return (
    <div>
      <div className="relative">
        <div ref={containerRef} className="h-52 w-full rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700" style={{ zIndex: 0 }} />
        <button
          type="button"
          onClick={() => setSatellite(s => !s)}
          className="absolute top-2 right-2 z-[500] rounded-lg bg-white/90 dark:bg-slate-800/90 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 shadow border border-slate-200 dark:border-slate-600 active:scale-95 transition"
        >
          {satellite ? 'Street view' : 'Satellite view'}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Tap the map to move the geofence center</p>
    </div>
  );
}
