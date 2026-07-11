import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface GeofenceMapProps {
  latitude: number;
  longitude: number;
  radius: number;
  onPick?: (lat: number, lng: number) => void;
}

/**
 * Geofence preview: OpenStreetMap with a marker + radius circle.
 * Tapping the map moves the geofence center (calls onPick).
 */
export default function GeofenceMap({ latitude, longitude, radius, onPick }: GeofenceMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
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
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      onPickRef.current?.(
        Math.round(e.latlng.lat * 1e6) / 1e6,
        Math.round(e.latlng.lng * 1e6) / 1e6,
      );
    });
    mapRef.current = map;
    // Leaflet mis-sizes inside animated containers; refresh after paint
    setTimeout(() => map.invalidateSize(), 200);
    return () => { map.remove(); mapRef.current = null; circleRef.current = null; markerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <div ref={containerRef} className="h-52 w-full rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700" style={{ zIndex: 0 }} />
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Tap the map to move the geofence center</p>
    </div>
  );
}
