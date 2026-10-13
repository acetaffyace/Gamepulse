// 保存显示状态，不覆盖网址里的业务筛选。以语义键关联，避免按 DOM 下标恢复错控件。
function scope(node, root) {
  const keys = [];
  for (let p = node; p && p !== root; p = p.parentElement) {
    if (p.dataset.stateKey) keys.unshift(p.dataset.stateKey);
  }
  return keys.join('/');
}
function identity(node, root) {
  const group = node.closest('[role="group"]')?.getAttribute('aria-label') || '';
  const label = node.getAttribute('aria-label') || node.closest('label')?.textContent.trim() || '';
  return [scope(node, root), node.tagName, node.id || '', group,
    node.dataset.value ?? node.getAttribute('value') ?? '', label || node.textContent.trim()].join('|');
}
function detailKey(node, root) {
  return scope(node, root) || `${node.className}:${node.querySelector(':scope > summary')?.textContent.trim()}`;
}
export function captureView(root) {
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  return {
    details: [...root.querySelectorAll('details')].map(n => [detailKey(n, root), n.open]),
    components: [...root.querySelectorAll('[data-state-key]')].filter(n => n.uiState)
      .map(n => [scope(n, root), n.uiState.get()]),
    focus: focused ? identity(focused, root) : null,
    selection: focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null,
    scroll: window.scrollY,
  };
}
export function restoreView(root, state, { focus = true, components: restoreComponents = true } = {}) {
  if (!state) return false;
  const details = new Map(state.details);
  root.querySelectorAll('details').forEach(n => { if (details.has(detailKey(n, root))) n.open = details.get(detailKey(n, root)); });
  const components = new Map(state.components);
  // 数据表视图恢复后才会创建表格；随后恢复表格的搜索、排序和页码。
  for (const selector of restoreComponents ? ['section[data-state-key]', '.table-view[data-state-key]'] : []) {
    root.querySelectorAll(selector).forEach(n => {
      const saved = components.get(scope(n, root));
      if (saved && n.uiState) n.uiState.restore(saved);
    });
  }
  if (focus && state.focus) {
    const target = [...root.querySelectorAll('button, input, select, textarea, summary, a, [tabindex]')]
      .find(n => identity(n, root) === state.focus && !n.disabled);
    if (target) {
      target.focus({ preventScroll: true });
      if (state.selection && target.setSelectionRange) target.setSelectionRange(...state.selection);
      return true;
    } else root.querySelector('h1')?.focus({ preventScroll: true });
  }
  return false;
}
