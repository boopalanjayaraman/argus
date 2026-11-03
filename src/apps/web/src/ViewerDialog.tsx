import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parsePly, mergeClouds } from './pointcloud';

export type Viewer =
  | { kind: 'photo'; index: number }
  | { kind: 'video' }
  | { kind: 'pointcloud' }
  | { kind: 'cad' };

function PointCloudCanvas({ urls, onStats, color = null, single = false }: { urls: string[]; onStats: (s: string) => void; color?: string | null; single?: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<() => void>(() => {});

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07080c);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const resize = () => {
      const w = mount.clientWidth || 800;
      const h = mount.clientHeight || 520;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let points: THREE.Points | null = null;
    (async () => {
      const clouds = [];
      let loaded = 0;
      const buffers = await Promise.all(urls.map(async (u) => {
        try { const r = await fetch(u); if (!r.ok) return null; return await r.arrayBuffer(); }
        catch { return null; }
      }));
      for (const buf of buffers) {
        if (!buf) continue;
        try { clouds.push(parsePly(buf)); loaded++; } catch { /* skip bad chunk */ }
      }
      if (disposed) return;
      if (!clouds.length) { onStats('No readable point-cloud chunks'); return; }
      const merged = mergeClouds(clouds);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(merged.positions, 3));
      if (merged.colors) {
        const colors = new Float32Array(merged.count * 3);
        for (let i = 0; i < merged.count * 3; i++) colors[i] = merged.colors[i] / 255;
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      }
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      geometry.translate(-center.x, -center.y, -center.z);
      const material = color
        ? new THREE.PointsMaterial({ size: Math.max(size / 160, 1), color, sizeAttenuation: true })
        : new THREE.PointsMaterial({ size: Math.max(size / 160, 1), vertexColors: true, sizeAttenuation: true });
      points = new THREE.Points(geometry, material);
      scene.add(points);
      const fit = () => {
        camera.position.set(size * 0.55, size * 0.4, size * 0.75);
        camera.near = Math.max(size / 1000, 0.01);
        camera.far = size * 20;
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();
      };
      fit();
      resetRef.current = fit;
      onStats(single ? `CAD reference cloud · ${merged.count.toLocaleString()} points rendered` : `${loaded} of ${urls.length} chunks loaded · ${merged.count.toLocaleString()} points rendered`);
    })();

    let raf = 0;
    const loop = () => { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
    loop();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (points) { points.geometry.dispose(); (points.material as THREE.Material).dispose(); }
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [urls.join('|')]);

  return (
    <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 420 }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
      <button type="button" className="ar-btn secondary sm" style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 3 }} onClick={() => resetRef.current()}>Reset view</button>
      <span className="ar-micro" style={{ position: 'absolute', left: 10, bottom: 12, zIndex: 3, color: 'var(--text-3)' }}>Drag to orbit · Scroll to zoom · Right-drag to pan</span>
    </div>
  );
}

const MASK_COLORS = ['#A594FF', '#4BE0A0', '#FFC554', '#6FD6E8', '#FF7468', '#7AB8FF', '#D5D8E4'];

/** A photograph with SAM 3.1's component masks and boxes drawn over it.
 * Coordinates are in the pixels of the still SAM saw (a uniformly scaled
 * copy of the photo), so the overlay uses that still's viewBox. */
function PhotoWithMasks({ sessionId, photo, src }: { sessionId: string; photo: any; src: string }) {
  const [seg, setSeg] = useState<any>(null);
  const [show, setShow] = useState(true);
  useEffect(() => {
    let live = true; setSeg(null);
    fetch(`/api/v1/inspections/${sessionId}/observations?evidenceId=${encodeURIComponent(photo.evidenceId)}`).then(r => r.json())
      .then(list => { if (live) setSeg((list || []).find((o: any) => o.kind === 'segmentation') || null); }).catch(() => {});
    return () => { live = false; };
  }, [sessionId, photo.evidenceId]);
  const comps = (seg?.payload?.components || []).filter((c: any) => c.boxes && !c.error);
  const dims = comps.find((c: any) => c.width && c.height);
  return (
    <>
      <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: '70vh', lineHeight: 0 }}>
        <img src={src} alt={photo.filename} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} />
        {show && dims && <svg viewBox={`0 0 ${dims.width} ${dims.height}`} preserveAspectRatio="none" aria-label="SAM 3.1 component masks" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {comps.map((c: any, ci: number) => c.objects.map((o: any) => {
            const col = MASK_COLORS[ci % MASK_COLORS.length];
            return <g key={`${c.id}-${o.objectId}`}>
              {o.mask?.svgPath && <path d={o.mask.svgPath} transform={`translate(${o.mask.bounds.left} ${o.mask.bounds.top})`} fill={col} fillOpacity={0.32} />}
              <rect x={o.box.left} y={o.box.top} width={o.box.right - o.box.left} height={o.box.bottom - o.box.top} fill="none" stroke={col} strokeWidth={Math.max(1.5, dims.width / 500)} />
              <text x={o.box.left + 4} y={Math.max(14, o.box.top - 4)} fill={col} fontSize={Math.max(12, dims.width / 70)} fontWeight={600}>{c.id.replace(/_/g, ' ')} {o.confidence !== undefined && o.confidence !== null ? Math.round(o.confidence * 100) + '%' : ''}</text>
            </g>;
          }))}
        </svg>}
      </div>
      <span className="ar-micro" style={{ position: 'absolute', left: 10, bottom: 10, zIndex: 3, background: '#0A0B10D9', padding: '2px 8px', borderRadius: 6 }}>
        {!seg ? 'No SAM segmentation yet' : comps.length ? `SAM 3.1: ${comps.map((c: any) => `${c.id.replace(/_/g, ' ')} (${c.boxes})`).join(' · ')}` : 'SAM 3.1: no configured component detected'}
      </span>
      {!!comps.length && <button type="button" className="ar-btn secondary sm" style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 3 }} onClick={() => setShow(!show)}>{show ? 'Hide masks' : 'Show masks'}</button>}
    </>
  );
}

export default function ViewerDialog({ viewer, sessionId, photos, videos, pcs, cadUrl, onClose, onPhoto }: {
  viewer: Viewer;
  sessionId: string;
  photos: any[];
  videos: any[];
  pcs: any[];
  cadUrl: string;
  onClose: () => void;
  onPhoto: (index: number) => void;
}) {
  const [pcStats, setPcStats] = useState('Loading point-cloud chunks…');
  const [videoFallback, setVideoFallback] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (viewer.kind === 'photo') {
        if (e.key === 'ArrowRight') onPhoto(Math.min(photos.length - 1, viewer.index + 1));
        if (e.key === 'ArrowLeft') onPhoto(Math.max(0, viewer.index - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, photos.length, onClose, onPhoto]);

  const fileUrl = (e: any) => `/api/v1/inspections/${sessionId}/evidence/${e.evidenceId}/file`;
  const title = viewer.kind === 'photo' ? 'Photograph' : viewer.kind === 'video' ? 'Video' : viewer.kind === 'cad' ? 'CAD reference' : 'Point cloud';

  return (
    <div className="ar-scrim" onClick={onClose}>
      <div className="ar-dialog" role="dialog" aria-modal="true" aria-label={`${title} viewer`}
        style={{ width: viewer.kind === 'pointcloud' || viewer.kind === 'cad' ? 1080 : 920, height: viewer.kind === 'pointcloud' || viewer.kind === 'cad' ? 'min(760px, 92vh)' : undefined, maxHeight: '92vh', padding: 18 }}
        onClick={e => e.stopPropagation()}>
        <div className="ar-bar" style={{ justifyContent: 'space-between', flex: 'none' }}>
          <h2 className="ar-h2">{title}</h2>
          <span className="ar-micro" style={{ flex: '1 1 auto', textAlign: 'center' }}>
            {viewer.kind === 'photo' && photos[viewer.index] ? `${photos[viewer.index].filename} · ${viewer.index + 1} of ${photos.length}` : ''}
            {viewer.kind === 'video' && videos.length ? (videoFallback ? videos[videos.length - 1].filename : `${videos[0].filename} \u2013 ${videos[videos.length - 1].filename} \u00B7 ${videos.length} segments merged`) : ''}
            {viewer.kind === 'pointcloud' || viewer.kind === 'cad' ? pcStats : ''}
          </span>
          <button type="button" className="ar-btn ghost sm icon-only" aria-label="Close viewer" onClick={onClose}>
            <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        {viewer.kind === 'photo' && photos[viewer.index] && (
          <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#07080C', borderRadius: 8, overflow: 'hidden' }}>
            <PhotoWithMasks sessionId={sessionId} photo={photos[viewer.index]} src={fileUrl(photos[viewer.index])} />
            {photos.length > 1 && <>
              <button type="button" className="ar-btn secondary sm" style={{ position: 'absolute', left: 10, top: '50%' }} disabled={viewer.index === 0} onClick={() => onPhoto(viewer.index - 1)}>‹ Prev</button>
              <button type="button" className="ar-btn secondary sm" style={{ position: 'absolute', right: 10, top: '50%' }} disabled={viewer.index === photos.length - 1} onClick={() => onPhoto(viewer.index + 1)}>Next ›</button>
            </>}
          </div>
        )}

        {viewer.kind === 'video' && videos.length > 0 && (
          <video key={videoFallback ? videos[videos.length - 1].evidenceId : 'merged'} controls autoPlay
            src={videoFallback ? fileUrl(videos[videos.length - 1]) : `/api/v1/inspections/${sessionId}/video/merged`}
            onError={() => setVideoFallback(true)}
            style={{ width: '100%', maxHeight: '72vh', background: '#07080C', borderRadius: 8 }} />
        )}

        {viewer.kind === 'pointcloud' && (
          <PointCloudCanvas urls={pcs.map(fileUrl)} onStats={setPcStats} />
        )}

        {viewer.kind === 'cad' && (
          <PointCloudCanvas urls={[cadUrl]} color="#9db4d0" single onStats={setPcStats} />
        )}
      </div>
    </div>
  );
}
