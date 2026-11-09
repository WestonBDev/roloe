// Deploy manifests keep the promises the README makes (Gitar review of step 9; Radar cluster layout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const k8s = read('deploy/coordinator.yaml');
const kust = read('deploy/kustomization.yaml');
const argo = read('argocd/application.yaml');

test('the cluster runs the image this repo builds, set by kustomize so each push rolls the pod', () => {
  assert.match(kust, /namespace: team-roloe/);
  assert.match(kust, /name: app\s+newName: ghcr\.io\/westonbdev\/roloe/);
  assert.match(k8s, /image: app\b/);
  assert.match(k8s, /name: ROLOE_PUBLIC_URL,\s*value:\s*"https:\/\/roloe\.cnh\.radarhq\.io"/);
});

test('cards and records survive a rollout: /data is a PersistentVolumeClaim', () => {
  assert.match(k8s, /kind: PersistentVolumeClaim/);
  assert.match(k8s, /name: data,?\s*persistentVolumeClaim:\s*\{?\s*claimName: roloe-data/);
});

test('the public URL routes to Service app on port 80, and lives in git (Argo self-heal)', () => {
  assert.match(k8s, /kind: Service\s+metadata:\s+name: app[\s\S]*port: 80/);
  assert.match(argo, /selfHeal: true/);
  assert.match(argo, /repoURL: https:\/\/github\.com\/WestonBDev\/roloe\.git/);
  assert.ok(!read('README.md').includes('edit configmap'));
});

test('hardened pod: non-root, read-only root, no capabilities, no API token (Radar Checks)', () => {
  assert.match(k8s, /automountServiceAccountToken: false/);
  assert.match(k8s, /runAsNonRoot: true/);
  assert.match(k8s, /readOnlyRootFilesystem: true/);
  assert.match(k8s, /drop: \["ALL"\]/);
});

test('no secret values in the manifests', () => {
  for (const f of [k8s, kust, argo]) assert.ok(!/ELASTIC_API_KEY:\s*\S|DASH0_AUTH_TOKEN:\s*\S|--from-literal=[A-Z_]+=[^.\s"$]/.test(f));
});

test('a startup probe checks every second, so a new pod is ready the moment it can serve (Radar investigation)', () => {
  const probe = k8s.slice(k8s.indexOf('startupProbe:'), k8s.indexOf('readinessProbe:'));
  assert.match(probe, /path: \/healthz/);
  assert.match(probe, /periodSeconds: 1\b/);
});
