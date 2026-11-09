// Deploy manifests keep the promises the README makes (Gitar review of step 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const k8s = readFileSync(new URL('../deploy/coordinator.yaml', import.meta.url), 'utf8');
const argo = readFileSync(new URL('../deploy/argocd-application.yaml', import.meta.url), 'utf8');

test('the code the cluster runs is a pinned commit, not a moving branch', () => {
  const ref = k8s.match(/ROLOE_REF:\s*"?([^\s"]+)/)[1];
  assert.match(ref, /^[0-9a-f]{40}$/);
});

test('cards and records survive a rollout: /data is a PersistentVolumeClaim', () => {
  assert.match(k8s, /kind: PersistentVolumeClaim/);
  assert.match(k8s, /name: data,?\s*persistentVolumeClaim:\s*\{?\s*claimName: roloe-data/);
});

test('the public URL lives in git (Argo self-heal would revert a kubectl edit)', () => {
  assert.match(k8s, /ROLOE_PUBLIC_URL:\s*https:\/\/roloe\.cnh\.radarhq\.io/);
  assert.match(k8s, /kind: Ingress[\s\S]*host: roloe\.cnh\.radarhq\.io/);
  assert.match(argo, /selfHeal: true/);
  assert.ok(!readFileSync(new URL('../README.md', import.meta.url), 'utf8').includes('edit configmap'));
});

test('no secret values in the manifests', () => {
  assert.ok(!/ELASTIC_API_KEY:\s*\S|DASH0_AUTH_TOKEN:\s*\S|--from-literal=[A-Z_]+=[^.\s]/.test(k8s));
});
