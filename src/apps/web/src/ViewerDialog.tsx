import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parsePly, mergeClouds } from './pointcloud';
import { boxAt } from './annotations';

export type Viewer =
  | { kind: 'photo'; index: number }
  | { kind: 'video'; tab?: 'original' | 'analyzed' }
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

/** Analyzed video (display only): the merged video with SAM 3.1 tracks and
 * lightly worded hints drawn from the session's FAIL / WARNING findings. */
function AnalyzedVideo({ sessionId, onShowFindings }: { sessionId: string; onShowFindings?: () => void }) {
  const [ann, setAnn] = useState<any>(null);
  const [t, setT] = useState(0);
  const [allParts, setAllParts] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const load = () => fetch(`/api/v1/inspections/${sessionId}/video/annotations`).then(r => r.json()).then(setAnn).catch(() => setAnn({ status: 'failed', reason: 'Could not load annotations' }));
  useEffect(() => { load(); }, [sessionId]);
  useEffect(() => {
    if (!ann || !['queued', 'running'].includes(ann.status)) return;
    const id = setInterval(load, 4000); return () => clearInterval(id);
  }, [ann?.status]);
  useEffect(() => {
    let raf = 0;
    const tick = () => { if (videoRef.current) setT(videoRef.current.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [ann?.status]);
  const analyze = async () => { await fetch(`/api/v1/inspections/${sessionId}/track-video`, { method: 'POST' }); load(); };

  if (!ann) return <div className="ar-empty"><strong>Loading the analyzed video…</strong></div>;
  if (ann.status !== 'ready') {
    const busy = ['queued', 'running'].includes(ann.status);
    return <div className="ar-empty" style={{ padding: '48px 20px' }}>
      <strong>{busy ? 'Following the valve parts through the video…' : ann.status === 'failed' ? 'The video could not be analyzed' : 'This video has not been analyzed yet'}</strong>
      <span>{busy ? 'SAM 3.1 is tracking each part frame by frame. This view updates when it finishes.' : ann.reason || 'Tracking runs automatically when the stream completes; you can also start it now.'}</span>
      {!busy && <button type="button" className="ar-btn secondary sm" style={{ marginTop: 8 }} onClick={analyze}>Analyze video</button>}
    </div>;
  }
  const labelsFor = (id: string) => (ann.labels || []).filter((l: any) => l.componentId === id);
  const tone = (s: string) => s === 'FAIL' ? '#FF9A8F' : '#FFC554';
  const W = ann.width || 1280, H = ann.height || 720;
  const shown = (ann.components || []).flatMap((c: any) => c.objects.map((o: any) => ({ c, o, box: boxAt(o.frames, ann.fps, t), labels: labelsFor(c.id) })))
    .filter((x: any) => x.box && (allParts || x.labels.length));
  return <>
    <div style={{ position: 'relative', width: '100%', maxWidth: `calc(62vh * ${W / H})`, aspectRatio: `${W} / ${H}`, margin: '0 auto', background: '#07080C', borderRadius: 8, overflow: 'hidden' }}>
      <video ref={videoRef} controls src={`/api/v1/inspections/${sessionId}/video/merged`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Tracked parts and possible issues" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {shown.map(({ c, o, box, labels }: any) => {
          const [l, tp, r, b] = box; const col = labels.length ? tone(labels.some((x: any) => x.status === 'FAIL') ? 'FAIL' : 'WARNING') : '#8D93A8';
          const fs = Math.max(16, W / 58), lh = fs + 8, padX = 6, maxW = W * 0.5;
          const sorted = [...labels].sort((x: any, y: any) => (x.status === 'FAIL' ? 0 : 1) - (y.status === 'FAIL' ? 0 : 1));
          const fit = (txt: string) => { const n = Math.floor((maxW - padX * 2) / (fs * 0.56)); return txt.length <= n ? txt : txt.slice(0, n - 1).trimEnd() + '…'; };
          const lines = sorted.length ? [fit(`Rule ${sorted[0].rule} · ${sorted[0].text}`)] : [c.id.replace(/_/g, ' ')];
          if (sorted.length > 1) lines.push(`+${sorted.length - 1} more possible ${sorted.length - 1 === 1 ? 'issue' : 'issues'} on this part`);
          const tw = Math.min(maxW, Math.max(...lines.map((x: string) => x.length)) * fs * 0.56 + padX * 2);
          const x0 = Math.max(4, Math.min(l, W - tw - 4));
          const above = tp - lines.length * lh - 10;
          const y0 = above >= 4 ? above : Math.min(b + 10, H - lines.length * lh - 4);
          const ax = Math.min(Math.max((l + r) / 2, x0 + 8), x0 + tw - 8), ay = y0 < tp ? y0 + lines.length * lh : y0;
          return <g key={`${c.id}-${o.objectId}`}>
            <rect x={l} y={tp} width={r - l} height={b - tp} fill="none" stroke={col} strokeWidth={Math.max(2, W / 500)} strokeDasharray={labels.length ? undefined : '6 4'} rx={4} />
            <line x1={ax} y1={ay} x2={(l + r) / 2} y2={y0 < tp ? tp : b} stroke={col} strokeOpacity={0.7} strokeWidth={Math.max(1.5, W / 800)} />
            <rect x={x0} y={y0} width={tw} height={lines.length * lh} rx={5} fill="#0A0B10" fillOpacity={0.8} stroke={col} strokeOpacity={0.6} />
            {lines.map((txt: string, i: number) => <text key={i} x={x0 + padX} y={y0 + (i + 1) * lh - 6} fill={col} fontSize={i === 0 ? fs : fs * 0.85} fontWeight={i === 0 ? 600 : 500}>{txt}</text>)}
          </g>;
        })}
      </svg>
    </div>
    <div className="ar-bar" style={{ justifyContent: 'space-between', gap: 10, flex: 'none' }}>
      <span className="ar-micro">{(ann.labels || []).length ? `${(ann.labels || []).length} possible ${(ann.labels || []).length === 1 ? 'issue' : 'issues'} shown on the parts they concern. These are hints from the findings, not verdicts.` : 'No possible issues on the tracked parts. Dashed boxes show the parts SAM 3.1 followed.'}{ann.current === false ? ' New video arrived after this analysis.' : ''}</span>
      <span className="ar-bar" style={{ gap: 8 }}>
        <button type="button" className="ar-btn ghost sm" onClick={() => setAllParts(!allParts)}>{allParts ? 'Hide other parts' : 'Show all tracked parts'}</button>
        {ann.current === false && <button type="button" className="ar-btn ghost sm" onClick={analyze}>Re-analyze</button>}
        {onShowFindings && <button type="button" className="ar-btn secondary sm" onClick={onShowFindings}>Check the findings</button>}
      </span>
    </div>
  </>;
}

export default function ViewerDialog({ viewer, sessionId, photos, videos, pcs, cadUrl, onClose, onPhoto, onShowFindings }: {
  viewer: Viewer;
  sessionId: string;
  photos: any[];
  videos: any[];
  pcs: any[];
  cadUrl: string;
  onClose: () => void;
  onPhoto: (index: number) => void;
  onShowFindings?: () => void;
}) {
  const [videoTab, setVideoTab] = useState<'original' | 'analyzed'>(viewer.kind === 'video' && viewer.tab === 'analyzed' ? 'analyzed' : 'original');
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
          <div className="ar-tabs" role="tablist" aria-label="Video views" style={{ flex: 'none', borderBottom: '1px solid var(--line)' }}>
            <button type="button" className="ar-tab" role="tab" aria-selected={videoTab === 'original'} onClick={() => setVideoTab('original')}>Original video</button>
            <button type="button" className="ar-tab" role="tab" aria-selected={videoTab === 'analyzed'} onClick={() => setVideoTab('analyzed')}>Analyzed video</button>
          </div>
        )}

        {viewer.kind === 'video' && videos.length > 0 && videoTab === 'analyzed' && <AnalyzedVideo sessionId={sessionId} onShowFindings={onShowFindings} />}

        {viewer.kind === 'video' && videos.length > 0 && videoTab === 'original' && (
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
