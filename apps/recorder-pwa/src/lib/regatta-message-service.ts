export type RegattaMessage = {
  id: number;
  deviceId: string;
  text: string;
  createdAt: string | null;
};

function messagesUrl(ingestUrl: string): string {
  const base = ingestUrl.replace(/\/api\/ingest\/?$/i, '');
  return `${base}/api/messages`;
}

export async function fetchRegattaMessage(
  ingestUrl: string,
  deviceId: string,
  ingestToken?: string,
): Promise<RegattaMessage | null> {
  const id = deviceId.trim();
  if (!id) return null;

  const url = `${messagesUrl(ingestUrl)}?deviceId=${encodeURIComponent(id)}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ingestToken?.trim()) headers.Authorization = `Bearer ${ingestToken.trim()}`;

  try {
    const res = await fetch(url, { headers });
    const data = (await res.json()) as {
      ok?: boolean;
      message?: RegattaMessage | null;
    };
    if (!res.ok || !data.ok) return null;
    return data.message ?? null;
  } catch {
    return null;
  }
}

/** Clear active regatta/crew message for this device (rower dismiss). */
export async function clearRegattaMessage(
  ingestUrl: string,
  deviceId: string,
  ingestToken?: string,
): Promise<boolean> {
  const id = deviceId.trim();
  if (!id) return false;

  const url = `${messagesUrl(ingestUrl)}?deviceId=${encodeURIComponent(id)}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ingestToken?.trim()) headers.Authorization = `Bearer ${ingestToken.trim()}`;

  try {
    const res = await fetch(url, { method: 'DELETE', headers });
    if (res.status === 404) return true;
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return res.ok && data.ok !== false;
  } catch {
    return false;
  }
}

export const REGATTA_MESSAGE_POLL_MS = 15_000;
