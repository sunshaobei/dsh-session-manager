import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(process.env.TRASH_CLIENT_ENTRY || new URL('../client.js', import.meta.url), 'utf8');
function setup({ rejectArchive = false } = {}) {
  let plugin, dictionaries;
  const slots = new Map(), calls = [], refreshes = [], menuStates = [], elements = [];
  const selection = { value: { key: 'active-session' } };
  const node = tag => {
    const el = { tag, children: [], style: { setProperty() {} }, listeners: {},
      appendChild(child) { this.children.push(child); },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      remove() {},
    };
    elements.push(el);
    return el;
  };
  const locale = {
    register(_ns, messages) { dictionaries = messages; return () => {}; },
    getLocale: () => ({ active: 'zh' }),
    bind: () => (key, params = {}) => dictionaries.zh[key].replace(/\{(\w+)\}/g, (_, name) => params[name] || ''),
  };
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {} };
  const MenuItemButton = Symbol('host MenuItemButton');
  vm.runInNewContext(source, {
    window: { navigator: { language: 'en' }, __ModuleLoader__: { load({ factory }) {
      plugin = factory(name => name === 'react' ? React : { MenuItemButton });
    } } },
    document: {
      createElement: node, getElementById: id => elements.find(el => el.id === id),
      head: node('head'), body: node('body'),
    },
    requestAnimationFrame: fn => { fn(); return 1; }, setTimeout() {}, console,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      if (rejectArchive && url.endsWith('/archive')) return { ok: false, json: async () => ({ ok: false, error: { code: 'SESSION_RUNNING', message: 'running' } }) };
      return { ok: true, json: async () => ({ ok: true, data: {} }) };
    },
  });
  plugin.apply({
    get: name => ({ locale, uiSession: { adapter: { current: selection } } })[name],
    effect: fn => fn(),
    slots: { inject: (_name, fn) => fn(), register(options, render) { slots.set(options.name, { options, render }); return () => {}; } },
    sessions: { list: { getSnapshot: () => ({ byId: { 'active-session': { title: '活动会话' }, 'next-session': { title: '下一个会话' } }, current: selection.value?.key }) }, refresh: () => refreshes.push('sessions') },
    workspaces: { refresh: () => refreshes.push('workspaces') },
  });
  return { plugin, slots, calls, refreshes, menuStates, selection, elements, MenuItemButton,
    menu(sessionId, displayTitle = '同名会话') {
      const slot = slots.get('sidebar.workspaces.session.menu.item');
      assert.ok(slot, 'the native session menu slot must be registered');
      return slot.render({ sessionId, displayTitle, useMenuOpenState: () => [true, value => menuStates.push(value)] });
    },
  };
}

test('native menu targets the selected row on a settings page without a current session', async () => {
  const ui = setup();
  ui.selection.value = undefined;
  const item = ui.menu('row-session', '测试对话');
  assert.equal(item.type, ui.MenuItemButton);
  assert.deepEqual(item.children, ['删除会话']);
  assert.equal(item.props.shortcut, undefined, 'do not copy the archive shortcut');
  await item.props.onSelect();
  assert.deepEqual(ui.menuStates, [false]);
  assert.deepEqual(ui.calls[0].body, { sessionId: 'row-session', title: '测试对话' });
  assert.equal(ui.calls[0].url, '/api/session-trash/archive');
  assert.equal(ui.calls[0].headers['x-dsh-plugin'], 'session-trash');
  assert.deepEqual(ui.refreshes, ['sessions', 'workspaces']);
});

test('same-title menus keep their own IDs when the active session changes', async () => {
  const ui = setup();
  const first = ui.menu('first'), second = ui.menu('second');
  ui.selection.value = { key: 'unrelated-session' };
  await second.props.onSelect();
  await first.props.onSelect();
  assert.deepEqual(ui.calls.map(call => call.body.sessionId), ['second', 'first']);
});

test('missing menu ID never falls back to deleting the active session', async () => {
  const ui = setup();
  const item = ui.menu(undefined);
  assert.equal(item.props.disabled, true);
  await item.props.onSelect();
  assert.equal(ui.calls.length, 0);
});

test('undo restores the same row and refreshes both lists', async () => {
  const ui = setup();
  await ui.menu('restore-me').props.onSelect();
  const undo = ui.elements.find(el => el.tag === 'button' && el.textContent === '撤销');
  assert.ok(undo);
  await undo.listeners.click();
  assert.deepEqual(ui.calls[1].body, { sessionId: 'restore-me' });
  assert.equal(ui.calls[1].url, '/api/session-trash/unarchive');
  assert.deepEqual(ui.refreshes, ['sessions', 'workspaces', 'sessions', 'workspaces']);
});

test('running-session rejection shows a localized error and does not purge UI state', async () => {
  const ui = setup({ rejectArchive: true });
  await ui.menu('running').props.onSelect();
  assert.equal(ui.refreshes.length, 0);
  assert.ok(ui.elements.some(el => el.textContent?.includes('会话正在运行中')));
});

test('header action reads the current UI binding when clicked', async () => {
  const ui = setup();
  // v0.5.0 reads the UI binding during render (for the tooltip), so the
  // selection must be set before mounting.
  ui.selection.value = { key: 'next-session' };
  const tree = ui.slots.get('conversation.session.header.actions').render({});
  const button = tree.props === null && Array.isArray(tree.children)
    ? tree.children.find((child) => child.props?.onClick)
    : tree;
  await button.props.onClick();
  assert.deepEqual(ui.calls[0].body, { sessionId: 'next-session', title: '下一个会话' });
});
