/** Toggle hidden `.info-help` panels next to circular (i) buttons. */
export function bindInfoToggles(root: ParentNode): void {
  root.querySelectorAll('[data-info-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const host =
        (btn as HTMLElement).closest(
          '.form-row, .coach-heading-with-info, .history-devices-field, .coach-logbook-heading, .status-line, .coach-monitor-bar, fieldset',
        ) || btn.parentElement;
      const help = host?.querySelector('.info-help') as HTMLElement | null;
      if (!help) return;
      help.hidden = !help.hidden;
      btn.setAttribute('aria-expanded', help.hidden ? 'false' : 'true');
    });
  });
}
