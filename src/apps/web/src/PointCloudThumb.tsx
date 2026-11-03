import { useEffect, useRef, useState } from 'react';
import { parsePly, mergeClouds } from './pointcloud';

/** Static fitted render of a point cloud for the evidence panes (PRD-09).
 *  Three.js is imported lazily so the session page bundle stays lean.
 *  No interaction and no motion: the pane click target opens the viewer. */
export default function PointCloudThumb({ urls, cap = 80000, color = null, label }: {
  urls: string[];
  cap?: number;
  color?: string | null;
  label: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !urls.length) return;
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      try {
        const THREE = await import('three');
        const clouds = [];
        for (const u of urls) {
          try {
            const r = await fetch(u);
            if (r.ok) clouds.push(parsePly(await r.arrayBuffer()));
          } catch { /* skip unreadable chunk */ }
        }
        if (disposed) return;
        if (!clouds.length) { setFailed(true); return; }
        const merged = mergeClouds(clouds, cap);
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        mount.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x07080c);
        const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100000);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(merged.positions, 3));
        let material;
        if (color || !merged.colors) {
          material = new THREE.PointsMaterial({ color: color || '#9db4d0', size: 2, sizeAttenuation: false });
        } else {
          const colors = new Float32Array(merged.count * 3);
          for (let i = 0; i < merged.count * 3; i++) colors[i] = merged.colors[i] / 255;
          geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          material = new THREE.PointsMaterial({ size: 2, vertexColors: true, sizeAttenuation: false });
        }
        const points = new THREE.Points(geometry, material);
        scene.add(points);
        geometry.computeBoundingBox();
        const box = geometry.boundingBox!;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        geometry.translate(-center.x, -center.y, -center.z);
        camera.position.set(size * 0.55, size * 0.4, size * 0.75);
        camera.near = Math.max(size / 1000, 0.01);
        camera.far = size * 20;
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        const render = () => {
          const w = mount.clientWidth || 480;
          const h = mount.clientHeight || 260;
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
        };
        render();
        const ro = new ResizeObserver(render);
        ro.observe(mount);
        cleanup = () => {
          ro.disconnect();
          geometry.dispose();
          material.dispose();
          renderer.dispose();
          if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
        };
      } catch { if (!disposed) setFailed(true); }
    })();
    return () => { disposed = true; cleanup(); };
  }, [urls.join('|'), cap, color]);

  if (failed) return null;
  return <div ref={mountRef} role="img" aria-label={label} style={{ position: 'absolute', inset: 0 }} />;
}
