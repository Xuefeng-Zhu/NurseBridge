import type { CallSnapshot } from '@nursebridge/contracts';
import { requestJson } from './workspace-api';

/** The authenticated response is the file; no saved export or second request. */
export async function downloadCaseExport(callId: string) {
  const snapshot = await requestJson<CallSnapshot>(`/api/calls/${callId}/export`, {
    method: 'POST', headers: { 'X-NurseBridge-View': 'staff' }, body: JSON.stringify({ format: 'json' }),
  });
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `nursebridge-${callId}.json`;
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Let the browser start reading the download before releasing its blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
