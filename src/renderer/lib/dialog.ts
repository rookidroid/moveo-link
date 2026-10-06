// Small modal dialogs (Electron has no window.prompt).

import { esc } from './core'

function open(html: string, focusSel: string): { root: HTMLDivElement; close(): void } {
  const root = document.createElement('div')
  root.className = 'modal-back'
  root.innerHTML = `<div class="modal card" role="dialog" aria-modal="true">${html}</div>`
  document.body.appendChild(root)
  const prev = document.activeElement as HTMLElement | null
  requestAnimationFrame(() => (root.querySelector(focusSel) as HTMLElement | null)?.focus())
  return { root, close() { root.remove(); prev?.focus?.() } }
}

/** Ask for a line of text. Resolves null when cancelled. */
export function promptText(title: string, value = '', okLabel = 'Save'): Promise<string | null> {
  return new Promise(resolve => {
    const d = open(`
      <div class="card-head"><h2>${esc(title)}</h2></div>
      <form class="card-body">
        <input type="text" class="text" value="${esc(value)}" maxlength="80" spellcheck="false"/>
        <div class="actions"><span class="grow"></span>
          <button type="button" class="btn ghost" data-act="cancel">Cancel</button>
          <button type="submit" class="btn primary">${esc(okLabel)}</button>
        </div>
      </form>`, 'input')
    const input = d.root.querySelector('input')!
    const done = (v: string | null) => { d.close(); resolve(v) }
    requestAnimationFrame(() => input.select())
    d.root.querySelector('form')!.addEventListener('submit', e => {
      e.preventDefault()
      const v = input.value.trim()
      if (v) done(v)
    })
    d.root.querySelector('[data-act=cancel]')!.addEventListener('click', () => done(null))
    d.root.addEventListener('keydown', e => { if (e.key === 'Escape') done(null) })
  })
}

/** Yes / no question. Resolves true on confirm. */
export function confirmDialog(message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise(resolve => {
    const d = open(`
      <div class="card-head"><h2>Confirm</h2></div>
      <div class="card-body">
        <p class="hint">${esc(message).replace(/\n/g, '<br/>')}</p>
        <div class="actions"><span class="grow"></span>
          <button type="button" class="btn ghost" data-act="cancel">Cancel</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(okLabel)}</button>
        </div>
      </div>`, '[data-act=ok]')
    const done = (v: boolean) => { d.close(); resolve(v) }
    d.root.querySelector('[data-act=ok]')!.addEventListener('click', () => done(true))
    d.root.querySelector('[data-act=cancel]')!.addEventListener('click', () => done(false))
    d.root.addEventListener('keydown', e => { if (e.key === 'Escape') done(false) })
  })
}
