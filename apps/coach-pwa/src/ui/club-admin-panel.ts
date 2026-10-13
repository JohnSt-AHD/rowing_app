import {
  createAdminOrg,
  fetchAdminOrgs,
  renameAdminOrg,
  rotateAdminOrgToken,
  type AdminOrg,
} from '../lib/api';
import {
  clearAdminToken,
  loadAdminToken,
  loadSettings,
  saveAdminToken,
  type CoachSettings,
} from '../lib/settings';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function formatCreated(raw: string | null | undefined): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-NZ', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export class ClubAdminPanel {
  private root: HTMLElement | null = null;
  private unlocked = Boolean(loadAdminToken());
  private orgs: AdminOrg[] = [];
  private oneTimeToken: { slug: string; token: string } | null = null;
  private busy = false;

  constructor(
    private getSettings: () => CoachSettings = loadSettings,
    private onStatus: (msg: string, isError?: boolean) => void = () => {},
  ) {}

  mount(el: HTMLElement): void {
    this.root = el;
    this.render();
    if (this.unlocked) void this.reload();
  }

  private adminToken(): string {
    return loadAdminToken();
  }

  private setBusy(v: boolean): void {
    this.busy = v;
    this.root?.querySelectorAll('button, input').forEach((node) => {
      (node as HTMLButtonElement | HTMLInputElement).disabled = v;
    });
  }

  private async reload(): Promise<void> {
    const token = this.adminToken();
    if (!token) {
      this.unlocked = false;
      this.render();
      return;
    }
    this.setBusy(true);
    try {
      this.orgs = await fetchAdminOrgs(this.getSettings(), token);
      this.unlocked = true;
      this.render();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/401|Unauthorized/i.test(msg)) {
        clearAdminToken();
        this.unlocked = false;
        this.orgs = [];
      }
      this.onStatus(msg, true);
      this.render();
    } finally {
      this.setBusy(false);
    }
  }

  private render(): void {
    if (!this.root) return;
    if (!this.unlocked) {
      this.root.innerHTML = `
        <h2 class="coach-section-title">Club admin (RNZ)</h2>
        <p class="club-admin__hint">
          Separate from the club ingest password. Requires server <code>ADMIN_TOKEN</code>.
        </p>
        <div class="form-row">
          <div class="form-row__meta">
            <span class="form-row__label">Admin password</span>
          </div>
          <input type="password" data-admin-token autocomplete="off" placeholder="ADMIN_TOKEN" />
        </div>
        <div class="coach-settings-actions">
          <button type="button" class="coach-btn coach-btn--primary" data-admin-unlock>Unlock</button>
        </div>
      `;
      this.bindLocked();
      return;
    }

    const rows = this.orgs
      .map(
        (o) => `
        <tr data-slug="${esc(o.slug)}">
          <td><code>${esc(o.slug)}</code></td>
          <td>${esc(o.name)}</td>
          <td>${esc(formatCreated(o.createdAt))}</td>
          <td class="club-admin__actions">
            <button type="button" class="coach-btn coach-btn--ghost" data-rename="${esc(o.slug)}">Rename</button>
            <button type="button" class="coach-btn coach-btn--ghost" data-rotate="${esc(o.slug)}">Rotate token</button>
          </td>
        </tr>`,
      )
      .join('');

    const tokenBox = this.oneTimeToken
      ? `
        <div class="club-admin__token-box" role="status">
          <p><strong>Copy this token now</strong> for <code>${esc(this.oneTimeToken.slug)}</code> — it cannot be shown again.</p>
          <input type="text" readonly data-one-time-token value="${esc(this.oneTimeToken.token)}" />
          <div class="club-admin__token-actions">
            <button type="button" class="coach-btn coach-btn--primary" data-copy-token>Copy</button>
            <button type="button" class="coach-btn coach-btn--ghost" data-dismiss-token>Dismiss</button>
          </div>
        </div>`
      : '';

    this.root.innerHTML = `
      <h2 class="coach-section-title">Club admin (RNZ)</h2>
      <p class="club-admin__hint">List, create, rename clubs and rotate ingest tokens. Tokens are shown once only.</p>
      <div class="club-admin__toolbar">
        <button type="button" class="coach-btn coach-btn--ghost" data-admin-refresh>Refresh</button>
        <button type="button" class="coach-btn coach-btn--ghost" data-admin-lock>Lock</button>
      </div>
      ${tokenBox}
      <div class="club-admin__table-wrap">
        <table class="club-admin__table">
          <thead>
            <tr><th>Slug</th><th>Name</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="4">No clubs yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      <h3 class="coach-section-title club-admin__subhead">Create club</h3>
      <div class="form-row">
        <div class="form-row__meta"><span class="form-row__label">Slug</span></div>
        <input type="text" data-create-slug placeholder="e.g. waikato" autocomplete="off" />
      </div>
      <div class="form-row">
        <div class="form-row__meta"><span class="form-row__label">Name</span></div>
        <input type="text" data-create-name placeholder="Display name" autocomplete="off" />
      </div>
      <div class="coach-settings-actions">
        <button type="button" class="coach-btn coach-btn--primary" data-create-club>Create club</button>
      </div>
    `;
    this.bindUnlocked();
  }

  private bindLocked(): void {
    const root = this.root;
    if (!root) return;
    root.querySelector('[data-admin-unlock]')?.addEventListener('click', () => {
      const input = root.querySelector('[data-admin-token]') as HTMLInputElement | null;
      const token = input?.value.trim() ?? '';
      if (!token) {
        this.onStatus('Enter ADMIN_TOKEN', true);
        return;
      }
      saveAdminToken(token);
      this.unlocked = true;
      void this.reload();
    });
  }

  private bindUnlocked(): void {
    const root = this.root;
    if (!root) return;

    root.querySelector('[data-admin-lock]')?.addEventListener('click', () => {
      clearAdminToken();
      this.unlocked = false;
      this.orgs = [];
      this.oneTimeToken = null;
      this.render();
      this.onStatus('Club admin locked');
    });

    root.querySelector('[data-admin-refresh]')?.addEventListener('click', () => {
      void this.reload();
    });

    root.querySelector('[data-copy-token]')?.addEventListener('click', () => {
      const input = root.querySelector('[data-one-time-token]') as HTMLInputElement | null;
      if (!input) return;
      void navigator.clipboard.writeText(input.value).then(
        () => this.onStatus('Token copied'),
        () => {
          input.select();
          this.onStatus('Select and copy the token manually');
        },
      );
    });

    root.querySelector('[data-dismiss-token]')?.addEventListener('click', () => {
      this.oneTimeToken = null;
      this.render();
    });

    root.querySelector('[data-create-club]')?.addEventListener('click', () => {
      void this.onCreate();
    });

    root.querySelectorAll('[data-rename]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slug = (btn as HTMLElement).dataset.rename || '';
        void this.onRename(slug);
      });
    });

    root.querySelectorAll('[data-rotate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slug = (btn as HTMLElement).dataset.rotate || '';
        void this.onRotate(slug);
      });
    });
  }

  private async onCreate(): Promise<void> {
    const root = this.root;
    if (!root || this.busy) return;
    const slug = (
      root.querySelector('[data-create-slug]') as HTMLInputElement | null
    )?.value.trim();
    const name = (
      root.querySelector('[data-create-name]') as HTMLInputElement | null
    )?.value.trim();
    if (!slug) {
      this.onStatus('Slug is required', true);
      return;
    }
    this.setBusy(true);
    try {
      const { org, token } = await createAdminOrg(
        this.getSettings(),
        this.adminToken(),
        slug,
        name || slug,
      );
      this.oneTimeToken = { slug: org.slug, token };
      this.onStatus(`Created club ${org.slug}`);
      await this.reload();
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
      this.setBusy(false);
    }
  }

  private async onRename(slug: string): Promise<void> {
    if (!slug || this.busy) return;
    const current = this.orgs.find((o) => o.slug === slug);
    const next = window.prompt(`New display name for ${slug}`, current?.name || slug);
    if (next == null) return;
    const name = next.trim();
    if (!name) {
      this.onStatus('Name is required', true);
      return;
    }
    this.setBusy(true);
    try {
      await renameAdminOrg(this.getSettings(), this.adminToken(), slug, name);
      this.onStatus(`Renamed ${slug}`);
      await this.reload();
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
      this.setBusy(false);
    }
  }

  private async onRotate(slug: string): Promise<void> {
    if (!slug || this.busy) return;
    const ok = window.confirm(
      `Rotate ingest token for "${slug}"?\n\nAll phones and Manager apps using the old token will stop working until updated.`,
    );
    if (!ok) return;
    this.setBusy(true);
    try {
      const { org, token } = await rotateAdminOrgToken(
        this.getSettings(),
        this.adminToken(),
        slug,
      );
      this.oneTimeToken = { slug: org.slug, token };
      this.onStatus(`Rotated token for ${org.slug}`);
      await this.reload();
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
      this.setBusy(false);
    }
  }
}
