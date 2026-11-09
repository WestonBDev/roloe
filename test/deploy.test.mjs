// Deploy manifests keep the promises the README makes (Gitar review of step 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const k8s = readFileSync(new URL('../deploy/coordinator.yaml', import.meta.url), 'utf8');
const argo = readFileSync(new URL('../deploy/argocd-application.yaml', import.meta.url), 'utf8');

test('the code the cluster runs is a pinned commit, set in the pod template so a bump rolls the pod (Gitar)', () => {
  const pod = k8s.slice(k8s.indexOf('kind: Deployment'), k8s.indexOf('kind: Service'));
  const ref = pod.match(/name: ROLOE_REF,\s*value:\s*"([0-9a-f]{40})"/);
  assert.ok(ref, 'ROLOE_REF is a literal env value in the Deployment, not only in the ConfigMap');
  assert.match(pod, /name: ROLOE_PUBLIC_URL,\s*value:\s*"https:\/\/roloe\.cnh\.radarhq\.io"/);
  assert.ok(!/ROLOE_REF:/.test(k8s.slice(0, k8s.indexOf('kind: Deployment'))), 'not duplicated in the ConfigMap');
});

test('cards and records survive a rollout: /data is a PersistentVolumeClaim', () => {
  assert.match(k8s, /kind: PersistentVolumeClaim/);
  assert.match(k8s, /name: data,?\s*persistentVolumeClaim:\s*\{?\s*claimName: roloe-data/);
});

test('the public URL lives in git (Argo self-heal would revert a kubectl edit)', () => {
  assert.match(k8s, /kind: Ingress[\s\S]*host: roloe\.cnh\.radarhq\.io/);
  assert.match(argo, /selfHeal: true/);
  assert.ok(!readFileSync(new URL('../README.md', import.meta.url), 'utf8').includes('edit configmap'));
});

test('no secret values in the manifests', () => {
  assert.ok(!/ELASTIC_API_KEY:\s*\S|DASH0_AUTH_TOKEN:\s*\S|--from-literal=[A-Z_]+=[^.\s]/.test(k8s));
});
