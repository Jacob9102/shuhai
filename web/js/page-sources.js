/**
 * page-sources.js —— 书源管理页
 * 列表 / 筛选 / 批量选择 / 批量操作 / 三种导入 / 导出 / 单源测试 / 批量体检 / 一键清理失效源。
 */

import { api, openSourceTestStream } from './api.js';
import {
  h, clear, icon, iconButton, toast, toastOk, toastErr, toastError, toastWarn,
  openModal, confirmDialog, promptDialog, actionSheet, emptyState, errorState, loadingBlock,
  longPress, debounce, formatDuration, fromNow, hostOf, formatTime,
} from './ui.js';

const PAGE_SIZE = 20;
const DEFAULT_TEST_KEYWORD = '斗破苍穹';

export async function render(root) {
  const state = {
    items: [],
    total: 0,
    page: 1,
    q: '',
    group: '',
    enabled: '',
    testStatus: '',
    testStats: null,
    groups: [],
    selected: new Set(),
    selectAllLoaded: false,
    loading: false,
    finished: false,
    observer: null,
    reqId: 0,
  };

  clear(root);

  /* ---------------- 顶部工具栏 ---------------- */
  const searchInput = h('input', {
    class: 'input input-sm', type: 'search', placeholder: '搜索书源名称或地址…',
    on: { input: debounce(() => { state.q = searchInput.value.trim(); reload(); }, 300) },
  });
  const groupSelect = h('select', {
    class: 'select input-sm', style: { width: 'auto' },
    on: { change: () => { state.group = groupSelect.value; reload(); } },
  });
  const enabledSelect = h('select', {
    class: 'select input-sm', style: { width: 'auto' },
    on: { change: () => { state.enabled = enabledSelect.value; reload(); } },
  });
  [['', '全部状态'], ['1', '已启用'], ['0', '已禁用']].forEach(([v, l]) => enabledSelect.appendChild(h('option', { value: v, text: l })));

  // 体检结果筛选：可用 / 失效 / 未测试
  const testStatusSelect = h('select', {
    class: 'select input-sm', style: { width: 'auto' }, title: '按体检结果筛选',
    on: { change: () => { state.testStatus = testStatusSelect.value; reload(); } },
  });
  [['', '全部体检结果'], ['ok', '可用'], ['fail', '失效'], ['untested', '未测试']]
    .forEach(([v, l]) => testStatusSelect.appendChild(h('option', { value: v, text: l })));

  // 全选（当前已加载的书源）
  const selectAllBox = h('input', {
    type: 'checkbox', class: 'source-check', 'aria-label': '全选已加载的书源',
    on: { change: () => toggleSelectLoaded(selectAllBox.checked) },
  });
  const selectAllLabel = h('label', { class: 'select-all', title: '全选当前已加载的书源' },
    selectAllBox, h('span', { text: '全选' }));

  // toolbar-secondary：桌面端直接显示，手机端收进「更多」菜单（避免工具栏横向溢出）
  const testAllBtn = h('button', {
    class: 'btn btn-sm toolbar-secondary', type: 'button', title: '对筛选出的全部书源做一次真实搜索体检，并标记可用/失效',
    on: { click: () => openTestRunner({ scopeLabel: scopeLabelText(), filter: currentFilter() }) },
  }, icon('play', 14), h('span', { text: '全量体检' }));

  const cleanBtn = h('button', {
    class: 'btn btn-sm btn-danger toolbar-secondary', type: 'button', title: '删除已被判定为失效的书源（从未测试过的不会被删除）',
    on: { click: () => openCleanInvalid() },
  }, icon('trash', 14), h('span', { text: '清理失效' }));

  const importBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', on: { click: () => openImport() } },
    icon('upload', 15), h('span', { text: '导入' }));
  const exportBtn = h('button', { class: 'btn btn-sm toolbar-secondary', type: 'button', on: { click: () => doExport() } },
    icon('download', 15), h('span', { text: '导出' }));
  const refreshBtn = iconButton('refresh', '刷新列表', () => reload(), { size: 16, class: 'toolbar-secondary' });

  // 手机端专用：把次要操作折进一个菜单，工具栏只留搜索框 / 筛选 / 导入 / 更多
  const moreBtn = h('button', {
    class: 'btn btn-sm only-mobile', type: 'button', title: '更多批量操作',
    on: {
      click: () => actionSheet([
        { label: '全量体检', icon: 'play', onClick: () => openTestRunner({ scopeLabel: scopeLabelText(), filter: currentFilter() }) },
        { label: '清理失效书源', icon: 'trash', danger: true, onClick: () => openCleanInvalid() },
        { label: '导出书源', icon: 'download', onClick: () => doExport() },
        { label: '刷新列表', icon: 'refresh', onClick: () => reload() },
      ], { title: '更多操作' }),
    },
  }, icon('more', 16), h('span', { text: '更多' }));

  const countLabel = h('span', { class: 'page-sub' });
  const statsLabel = h('span', { class: 'page-sub source-health' });

  root.appendChild(h('div', { class: 'page-head' },
    h('h1', { class: 'page-title' }, icon('source', 20), h('span', { text: '书源管理' })),
    countLabel,
    statsLabel,
    h('span', { class: 'spacer' })
  ));

  root.appendChild(h('div', { class: 'toolbar source-toolbar' },
    h('div', { class: 'search-box', style: { maxWidth: '300px' } }, icon('search', 17), searchInput),
    groupSelect,
    enabledSelect,
    testStatusSelect,
    selectAllLabel,
    h('span', { class: 'spacer' }),
    testAllBtn, cleanBtn, importBtn, exportBtn, refreshBtn, moreBtn
  ));

  const listBox = h('div', { class: 'source-list' });
  root.appendChild(listBox);

  const batchBar = h('div', { class: 'batch-bar', style: { display: 'none' } });
  root.appendChild(batchBar);

  /* ---------------- 数据加载 ---------------- */

  async function reload(opts = {}) {
    state.page = 1;
    state.items = [];
    state.finished = false;
    if (!opts.keepSelection) state.selected.clear();
    clear(listBox);
    listBox.appendChild(loadingBlock('正在加载书源…'));
    await loadPage();
  }

  async function loadPage() {
    if (state.loading || state.finished) return;
    state.loading = true;
    const reqId = ++state.reqId;
    try {
      const data = await api.sourceList({
        q: state.q || undefined,
        group: state.group || undefined,
        enabled: state.enabled === '' ? undefined : state.enabled,
        status: state.testStatus || undefined,
        page: state.page,
        limit: PAGE_SIZE,
      });
      if (reqId !== state.reqId) return;
      const items = (data && data.items) || [];
      state.total = (data && data.total) || items.length;
      state.groups = (data && data.groups) || state.groups;
      state.testStats = (data && data.testStats) || state.testStats;
      state.items = state.items.concat(items);
      if (state.page === 1) clear(listBox);
      renderList(items, state.page === 1);
      state.page += 1;
      if (state.items.length >= state.total || !items.length) state.finished = true;
      syncGroupOptions();
      updateCount();
      updateBatchBar();
    } catch (err) {
      if (reqId !== state.reqId) return;
      if (state.page === 1) {
        clear(listBox);
        listBox.appendChild(errorState(err, () => reload()));
      } else {
        toastError(err, '加载更多失败');
      }
      state.finished = true;
    } finally {
      state.loading = false;
    }
  }

  function updateCount() {
    countLabel.textContent = '共 ' + state.total + ' 个书源' + (state.selected.size ? ' · 已选 ' + state.selected.size : '');
    const s = state.testStats;
    clear(statsLabel);
    if (s) {
      statsLabel.appendChild(h('span', { class: 'badge badge-ok', title: '最近一次体检搜索成功', text: '可用 ' + s.ok }));
      statsLabel.appendChild(h('span', { class: 'badge badge-err', title: '最近一次体检搜索失败', text: '失效 ' + s.fail }));
      statsLabel.appendChild(h('span', { class: 'badge', title: '尚未体检过', text: '未测试 ' + s.untested }));
    }
    syncSelectAllBox();
  }

  /** 全选框状态：已加载项全选时勾上，部分选中时显示为半选 */
  function syncSelectAllBox() {
    const ids = state.items.map((x) => x.id);
    const picked = ids.filter((id) => state.selected.has(id)).length;
    selectAllBox.checked = ids.length > 0 && picked === ids.length;
    selectAllBox.indeterminate = picked > 0 && picked < ids.length;
  }

  function toggleSelectLoaded(on) {
    for (const src of state.items) {
      if (on) state.selected.add(src.id);
      else state.selected.delete(src.id);
    }
    for (const card of listBox.querySelectorAll('.source-card')) {
      const cb = card.querySelector('.source-check');
      const id = Number(card.dataset.id);
      if (cb) cb.checked = on && state.selected.has(id);
      card.classList.toggle('selected', state.selected.has(id));
    }
    updateBatchBar();
    updateCount();
  }

  /** 选中当前筛选条件下的全部书源（跨页），用于「批量测试全部」这类场景 */
  async function selectAllMatching() {
    const ids = [];
    let page = 1;
    for (;;) {
      const data = await api.sourceList({
        q: state.q || undefined,
        group: state.group || undefined,
        enabled: state.enabled === '' ? undefined : state.enabled,
        status: state.testStatus || undefined,
        page,
        limit: 200,
      });
      const items = (data && data.items) || [];
      ids.push(...items.map((x) => x.id));
      if (!items.length || ids.length >= (data.total || 0) || page >= 20) break;
      page += 1;
    }
    state.selected = new Set(ids);
    toastOk('已选中 ' + ids.length + ' 个书源');
    await reload({ keepSelection: true });
  }

  function syncGroupOptions() {
    const cur = groupSelect.value;
    clear(groupSelect);
    groupSelect.appendChild(h('option', { value: '', text: '全部分组' }));
    for (const g of state.groups) {
      groupSelect.appendChild(h('option', { value: g, text: g === '' ? '未分组' : g }));
    }
    groupSelect.value = cur || '';
  }

  /* ---------------- 列表渲染 ---------------- */

  function renderList(items, isFirst) {
    const frag = document.createDocumentFragment();
    for (const src of items) frag.appendChild(buildSourceCard(src));
    // 移除旧的哨兵后再追加
    const old = listBox.querySelector('.src-sentinel');
    if (old) old.remove();
    listBox.appendChild(frag);

    if (!state.items.length) {
      listBox.appendChild(emptyState({
        icon: 'source',
        title: '还没有书源',
        desc: '点击「导入」粘贴书源 JSON、填写订阅地址，或选择本地 .json 文件导入。',
        actionLabel: '导入书源',
        onAction: () => openImport(),
      }));
      return;
    }
    if (!state.finished) {
      const sen = h('div', { class: 'src-sentinel', style: { height: '2px' } });
      listBox.appendChild(sen);
      if (state.observer) state.observer.disconnect();
      state.observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) loadPage();
      }, { rootMargin: '300px' });
      state.observer.observe(sen);
    } else if (isFirst && state.items.length) {
      listBox.appendChild(h('div', { class: 'page-sub', style: { textAlign: 'center', padding: '10px' }, text: '已加载全部 ' + state.items.length + ' 个书源' }));
    }
  }

  function buildSourceCard(src) {
    const checkbox = h('input', {
      class: 'source-check', type: 'checkbox',
      on: {
        change: () => {
          if (checkbox.checked) state.selected.add(src.id);
          else state.selected.delete(src.id);
          card.classList.toggle('selected', checkbox.checked);
          updateBatchBar();
          updateCount();
        },
      },
    });
    checkbox.checked = state.selected.has(src.id);

    const swInput = h('input', {
      type: 'checkbox', checked: !!src.enabled,
      on: {
        change: async () => {
          const next = swInput.checked;
          try {
            await api.sourcePatch(src.id, { enabled: next });
            src.enabled = next;
            card.classList.toggle('disabled', !next);
            toastOk(next ? '已启用' : '已禁用');
          } catch (err) {
            swInput.checked = !next;
            toastError(err, '切换失败');
          }
        },
      },
    });
    const sw = h('label', { class: 'switch', title: src.enabled ? '点击禁用' : '点击启用' }, swInput, h('span', { class: 'track' }));

    const rules = h('div', { class: 'source-rules' },
      ruleDot('搜', src.ruleStats && src.ruleStats.hasSearch, '搜索规则'),
      ruleDot('详', src.ruleStats && src.ruleStats.hasBookInfo, '详情规则'),
      ruleDot('目', src.ruleStats && src.ruleStats.hasToc, '目录规则'),
      ruleDot('文', src.ruleStats && src.ruleStats.hasContent, '正文规则')
    );

    const card = h('div', { class: 'source-card' + (src.enabled ? '' : ' disabled') + (checkbox.checked ? ' selected' : '') , dataset: { id: String(src.id) } },
      checkbox,
      h('div', { class: 'source-main' },
        h('div', { class: 'source-title' },
          h('span', { class: 'source-name', text: src.name || '未命名书源' }),
          src.group ? h('span', { class: 'badge', text: src.group }) : null,
          healthBadge(src),
          !src.searchable ? h('span', { class: 'badge badge-warn', text: '未配置搜索' }) : null
        ),
        // 域名：点击可复制（手机上经常要把域名丢去别处查）；过长时由 CSS 做中段省略
        h('div', {
          class: 'source-url', role: 'button', tabindex: '0', title: '点击复制域名：' + hostOf(src.url),
          on: {
            click: (ev) => { ev.stopPropagation(); copyHost(hostOf(src.url)); },
            keydown: (ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); copyHost(hostOf(src.url)); } },
          },
        }, icon('link', 13), h('span', { class: 'url-text', text: hostOf(src.url) })),
        h('div', { class: 'source-meta' },
          h('span', {}, icon('layers', 13), h('span', { text: ' 权重 ' + (src.weight || 0) })),
          h('span', {}, icon('clock', 13), h('span', { text: ' 响应 ' + (src.respondTime ? formatDuration(src.respondTime) : '未测') })),
          h('span', {}, icon('refresh', 13), h('span', { text: ' 更新 ' + fromNow(src.updatedAt || src.lastUpdateTime) })),
          rules
        )
      ),
      h('div', { class: 'source-actions' },
        sw,
        h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => testSource(src) } }, icon('play', 14), h('span', { text: '测试' })),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: '更多操作', on: { click: (ev) => sourceMenu(src, ev) } }, icon('more', 16))
      )
    );

    // 长按/右键快捷菜单
    longPress(card, () => sourceMenu(src), { duration: 550 });
    return card;
  }

  /** 复制域名：优先用 Clipboard API，失败时退回到临时 textarea */
  function copyHost(host) {
    const done = () => toastOk('已复制：' + host);
    const fallback = () => {
      try {
        const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
        ta.value = host;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) {
        toastWarn('复制失败，请手动选择域名');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(host).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function ruleDot(label, on, title) {
    return h('span', { class: 'rule-dot ' + (on ? 'on' : 'off'), title: title + (on ? ' 已配置' : ' 缺失'), text: label });
  }

  /** 体检结果徽标：可用 / 失效 / 未测试，点击可看详情 */
  function healthBadge(src) {
    const status = src.testStatus || 'untested';
    const map = {
      ok: { cls: 'badge badge-ok health-ok', text: '可用 ' + (src.lastTestCount || 0) + ' 条' },
      fail: { cls: 'badge badge-err health-fail', text: '失效' },
      untested: { cls: 'badge health-untested', text: '未测试' },
    };
    const m = map[status] || map.untested;
    const tip = status === 'untested'
      ? '尚未体检，点击测试'
      : (status === 'ok' ? '体检通过：' : '体检失败：') + formatTime(src.lastTestAt) +
        (src.lastTestError ? ' · ' + src.lastTestError : '');
    return h('button', {
      class: m.cls, type: 'button', title: tip + '（点击查看体检详情）',
      style: { cursor: 'pointer' },
      on: { click: (ev) => { ev.stopPropagation(); openHealthDetail(src); } },
    }, h('span', { text: m.text }));
  }

  /** 体检详情：优先展示已存结果，可当场重测 */
  function openHealthDetail(src) {
    const body = h('div', {});
    const info = h('div', {});
    const render = (s) => {
      clear(info);
      info.appendChild(h('div', { class: 'cache-stat' },
        statItem(s.testStatus === 'ok' ? '可用' : (s.testStatus === 'fail' ? '失效' : '未测试'), '体检结论'),
        statItem(String(s.lastTestCount || 0), '命中条数'),
        statItem(s.lastTestAt ? formatTime(s.lastTestAt) : '—', '最近体检时间')
      ));
      if (s.lastTestError) {
        info.appendChild(h('p', { style: { color: 'var(--ui-danger)', marginTop: '10px' }, text: '失败原因：' + s.lastTestError }));
      } else if (s.testStatus === 'untested') {
        info.appendChild(h('p', { class: 'muted small', style: { marginTop: '10px' }, text: '该源还没有体检记录，点下方「立即测试」跑一次真实搜索。' }));
      }
      info.appendChild(h('p', { class: 'form-hint', style: { marginTop: '12px' }, text: '提示：体检 = 用关键字真实搜一次，命中 ≥1 条即判定为可用。' }));
    };
    render(src);
    const retestBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '立即测试', on: { click: () => run() } });
    const handle = openModal({
      title: '体检详情 · ' + (src.name || ''), size: 'md', body,
      footer: [
        h('button', { class: 'btn btn-ghost', type: 'button', text: '关闭', on: { click: () => handle.close() } }),
        retestBtn,
      ],
    });
    body.appendChild(info);
    let busy = false;
    async function run() {
      if (busy) return;
      busy = true;
      retestBtn.disabled = true;
      retestBtn.textContent = '测试中…';
      try {
        const d = await api.sourceTest(src.id, DEFAULT_TEST_KEYWORD);
        Object.assign(src, {
          testStatus: d.ok ? 'ok' : 'fail',
          lastTestAt: Date.now(),
          lastTestCount: d.count || 0,
          lastTestOk: !!d.ok,
          lastTestError: d.error || '',
          respondTime: d.elapsed,
        });
        render(src);
        updateListBadges();
        toastOk(d.ok ? '体检通过，命中 ' + d.count + ' 条' : '体检失败：' + (d.error || '无结果'));
      } catch (err) {
        toastError(err, '测试失败');
      } finally {
        busy = false;
        retestBtn.disabled = false;
        retestBtn.textContent = '立即测试';
      }
    }
  }

  /** 单源测试后刷新列表与顶部统计（保留当前选择） */
  function updateListBadges() {
    reload({ keepSelection: true });
  }

  /** 单源操作菜单 */
  function sourceMenu(src) {
    actionSheet([
      { label: '测试该书源', icon: 'play', onClick: () => testSource(src) },
      { label: src.enabled ? '禁用' : '启用', icon: 'check', onClick: () => toggleEnabled(src) },
      { label: '修改权重', icon: 'sort', onClick: () => editWeight(src) },
      { label: '移动到分组', icon: 'folder', onClick: () => editGroup([src.id]) },
      { label: '查看原始 JSON', icon: 'note', onClick: () => viewRaw(src) },
      { label: '删除书源', icon: 'trash', danger: true, onClick: () => deleteSources([src.id], src.name) },
    ], { title: src.name });
  }

  async function toggleEnabled(src) {
    try {
      await api.sourcePatch(src.id, { enabled: !src.enabled });
      toastOk(src.enabled ? '已禁用' : '已启用');
      reload();
    } catch (err) { toastError(err, '操作失败'); }
  }

  async function editWeight(src) {
    const val = await promptDialog({ title: '修改权重', label: '权重（越大搜索时越靠前）', value: String(src.weight || 0) });
    if (val === null) return;
    const weight = parseInt(val, 10);
    if (!Number.isFinite(weight)) { toastWarn('请输入数字'); return; }
    try { await api.sourcePatch(src.id, { weight }); toastOk('权重已更新'); reload(); }
    catch (err) { toastError(err, '更新失败'); }
  }

  async function viewRaw(src) {
    const body = h('div', {}, loadingBlock('读取中…'));
    const handle = openModal({ title: '原始书源 JSON · ' + (src.name || ''), size: 'lg', body });
    try {
      const data = await api.sourceGet(src.id);
      clear(body);
      const ta = h('textarea', { class: 'textarea', style: { minHeight: '320px' }, readonly: true });
      ta.value = JSON.stringify((data && data.raw) || data || {}, null, 2);
      body.appendChild(ta);
    } catch (err) {
      clear(body);
      body.appendChild(errorState(err));
    }
  }

  /* ---------------- 批量操作 ---------------- */

  function updateBatchBar() {
    clear(batchBar);
    const n = state.selected.size;
    batchBar.style.display = n ? '' : 'none';
    // has-batch 给列表补足底部留白，手机端吸底栏不会压住最后一张卡片
    listBox.classList.toggle('has-batch', !!n);
    if (!n) return;
    batchBar.appendChild(h('strong', { text: '已选 ' + n + ' 个' }));
    const ids = Array.from(state.selected);
    batchBar.appendChild(h('button', { class: 'btn btn-sm btn-primary', type: 'button', title: '对选中的书源逐个做真实搜索体检', on: { click: () => openTestRunner({ ids, scopeLabel: '选中的 ' + n + ' 个' }) } }, icon('play', 14), h('span', { text: '批量测试' })));
    batchBar.appendChild(h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => batchPatch({ enabled: true }) } }, icon('check', 14), h('span', { text: '批量启用' })));
    batchBar.appendChild(h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => batchPatch({ enabled: false }) } }, icon('close', 14), h('span', { text: '批量禁用' })));
    batchBar.appendChild(h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => editGroup(ids) } }, icon('folder', 14), h('span', { text: '移动到分组' })));
    batchBar.appendChild(h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => doExport(ids) } }, icon('download', 14), h('span', { text: '导出所选' })));
    batchBar.appendChild(h('button', { class: 'btn btn-sm btn-danger', type: 'button', title: '仅删除选中项里已被判定为失效的书源', on: { click: () => openCleanInvalid({ ids }) } }, icon('trash', 14), h('span', { text: '删除失效' })));
    batchBar.appendChild(h('button', { class: 'btn btn-sm btn-danger', type: 'button', on: { click: () => deleteSources(ids) } }, icon('trash', 14), h('span', { text: '删除' })));
    batchBar.appendChild(h('span', { class: 'spacer' }));
    if (state.total > state.items.length) {
      batchBar.appendChild(h('button', { class: 'btn btn-sm', type: 'button', title: '把当前筛选条件下的全部书源都选上（含未加载的页）', on: { click: () => selectAllMatching() } }, icon('check', 14), h('span', { text: '选中全部 ' + state.total + ' 个' })));
    }
    batchBar.appendChild(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '取消选择', on: { click: () => { state.selected.clear(); reload(); } } }));
  }

  /* ---------------- 批量体检 / 一键清理失效书源 ---------------- */

  /** 当前筛选条件（用于「全量体检」这类跟随筛选的操作） */
  function currentFilter() {
    return {
      q: state.q || '',
      group: state.group || '',
      enabled: state.enabled,
      status: state.testStatus,
    };
  }

  function scopeLabelText() {
    const bits = [];
    if (state.q) bits.push('关键字「' + state.q + '」');
    if (state.group) bits.push('分组「' + state.group + '」');
    if (state.enabled === '1') bits.push('已启用');
    if (state.enabled === '0') bits.push('已禁用');
    if (state.testStatus === 'ok') bits.push('可用');
    if (state.testStatus === 'fail') bits.push('失效');
    if (state.testStatus === 'untested') bits.push('未测试');
    return bits.length ? bits.join(' · ') : '全部书源';
  }

  /**
   * 批量体检运行器：SSE 实时进度 + 结果列表 + 完成后可一键删除失败的。
   * @param {object} opts { ids?, filter?, scopeLabel? }
   */
  function openTestRunner(opts = {}) {
    const scopeLabel = opts.scopeLabel || '全部书源';
    const results = [];
    let stream = null;
    let finished = false;

    const counter = h('div', { class: 'cache-stat' },
      statItem('0 / 0', '进度'),
      statItem('0', '可用'),
      statItem('0', '失效')
    );
    const bar = h('div', { class: 'progress-bar' }, h('i', { style: { width: '0%' } }));
    const listBoxEl = h('div', { class: 'health-list' });
    const tip = h('p', { class: 'form-hint', text: '体检 = 用关键字真实搜索一次，命中 ≥1 条判定为可用；结果会写入书源列表。' });
    const summaryBox = h('div', { class: 'import-result', style: { display: 'none' } });
    const body = h('div', {}, counter, bar, tip, summaryBox, listBoxEl);

    const stopBtn = h('button', { class: 'btn btn-ghost', type: 'button', text: '中止', on: { click: () => { stop(); handle.close(); } } });
    const closeBtn = h('button', { class: 'btn', type: 'button', text: '关闭', on: { click: () => { stop(); handle.close(); } } });
    const handle = openModal({
      title: '批量体检 · ' + scopeLabel, size: 'lg', body,
      footer: [stopBtn, closeBtn],
      onClose: () => stop(),
    });

    function stop() {
      if (stream) { try { stream.close(); } catch (e) { /* 忽略 */ } stream = null; }
    }

    function paint(done, total, ok, fail) {
      clear(counter);
      counter.appendChild(statItem(done + ' / ' + total, '进度'));
      counter.appendChild(statItem(String(ok), '可用'));
      counter.appendChild(statItem(String(fail), '失效'));
      bar.firstChild.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    }

    function addRow(item) {
      const row = h('div', { class: 'health-row ' + (item.ok ? 'ok' : 'fail') },
        h('span', { class: 'health-dot' }),
        h('span', { class: 'health-name', text: item.name || ('#' + item.id) }),
        h('span', { class: 'health-msg', text: item.ok ? ('命中 ' + item.count + ' 条 · ' + formatDuration(item.elapsed)) : (item.error || '无结果') })
      );
      listBoxEl.appendChild(row);
      listBoxEl.scrollTop = listBoxEl.scrollHeight;
    }

    function finish(summary) {
      finished = true;
      stopBtn.textContent = '关闭';
      stopBtn.onclick = () => handle.close();
      const failed = results.filter((r) => !r.ok);
      clear(summaryBox);
      summaryBox.style.display = '';
      summaryBox.appendChild(h('div', { class: 'line' },
        h('strong', { text: '体检完成：' }),
        h('span', { class: 'badge badge-ok', text: '可用 ' + (summary.ok || 0) }),
        h('span', { class: 'badge badge-err', text: '失效 ' + (summary.fail || 0) }),
        h('span', { class: 'badge', text: '耗时 ' + formatDuration(summary.took || 0) })
      ));
      if (failed.length) {
        const delBtn = h('button', {
          class: 'btn btn-sm btn-danger', type: 'button', text: '删除失效的 ' + failed.length + ' 个',
          on: { click: () => deleteFailed(failed, delBtn) },
        });
        summaryBox.appendChild(h('div', { class: 'line' }, delBtn));
      } else {
        summaryBox.appendChild(h('div', { class: 'line muted small', text: '没有发现失效书源 🎉' }));
      }
      updateListBadges();
    }

    async function deleteFailed(failed, btn) {
      const ok = await confirmDialog(
        '将删除本次体检失败的 ' + failed.length + ' 个书源，此操作不可恢复。',
        { danger: true, okLabel: '删除' }
      );
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = '删除中…';
      try {
        const r = await api.sourceDeleteInvalid({ ids: failed.map((f) => f.id) });
        toastOk('已删除 ' + (r.deleted || 0) + ' 个失效书源');
        state.selected.clear();
        updateListBadges();
        handle.close();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '删除失效的 ' + failed.length + ' 个';
        toastError(err, '删除失败');
      }
    }

    stream = openSourceTestStream({
      ids: opts.ids && opts.ids.length ? opts.ids : undefined,
      // 未显式给 ids 时，按列表页当前筛选条件圈定范围（与顶部提示一致）
      ...(opts.ids && opts.ids.length ? {} : (opts.filter || {})),
      keyword: DEFAULT_TEST_KEYWORD,
      concurrency: 6,
    }, {
      onStart: (d) => { paint(0, d.total || 0, 0, 0); tip.textContent = '正在用关键字「' + (d.keyword || DEFAULT_TEST_KEYWORD) + '」逐个体检，共 ' + (d.total || 0) + ' 个…'; },
      onResult: (d) => {
        results.push(d);
        addRow(d);
        paint(d.done || results.length, d.total || results.length, results.filter((r) => r.ok).length, results.filter((r) => !r.ok).length);
      },
      onDone: (d) => finish(d || {}),
      onError: (err) => {
        if (finished) return;
        stopBtn.disabled = true;
        clear(summaryBox);
        summaryBox.style.display = '';
        summaryBox.appendChild(h('div', { class: 'line', style: { color: 'var(--ui-danger)' }, text: '体检中断：' + (err.message || '未知错误') }));
        toastError(err, '批量体检失败');
      },
    });
  }

  /** 一键清理失效书源：可直接删，也可先重新体检再删 */
  function openCleanInvalid(opts = {}) {
    const ids = opts.ids && opts.ids.length ? opts.ids : null;
    const scopeLabel = ids ? '选中的 ' + ids.length + ' 个' : scopeLabelText();
    const s = state.testStats || { fail: 0, untested: 0, total: 0 };

    let mode = ids ? 'retest' : (s.fail > 0 ? 'direct' : 'retest');
    const radioName = 'clean-mode-' + Date.now();

    const mkOption = (value, label, desc, disabled) => {
      const input = h('input', {
        type: 'radio', name: radioName, value, disabled: !!disabled,
        on: { change: () => { if (input.checked) mode = value; } },
      });
      if (mode === value) input.checked = true;
      return h('label', { class: 'clean-option' + (disabled ? ' disabled' : '') },
        input,
        h('span', { class: 'clean-option-main' },
          h('span', { class: 'clean-option-title', text: label }),
          h('span', { class: 'clean-option-desc', text: desc })
        )
      );
    };

    const body = h('div', {},
      h('p', { class: 'form-hint', text: '范围：' + scopeLabel + '。仅删除「体检过且失败」的书源，从未测试过的绝不会被删。' }),
      mkOption('direct', '直接删除已知失效的 ' + (ids ? '（按选中范围）' : s.fail + ' 个'),
        ids ? '只处理选中项里已标记失效的源。' : '按上次体检结果立刻删除，速度快。', ids ? false : s.fail === 0),
      mkOption('retest', '先重新体检一遍，再删除失效的',
        '会真实搜索一次，能发现刚失效的源，但耗时较长。'),
    );

    const submit = h('button', { class: 'btn btn-danger', type: 'button', text: '开始清理' });
    const handle = openModal({
      title: '清理失效书源', size: 'md', body,
      footer: [
        h('button', { class: 'btn btn-ghost', type: 'button', text: '取消', on: { click: () => handle.close() } }),
        submit,
      ],
    });

    submit.addEventListener('click', async () => {
      handle.close();
      if (mode === 'retest') {
        // 复用体检弹窗：先跑进度，完成后提示删除失败的
        openTestRunner({ ids, scopeLabel, filter: ids ? null : currentFilter() });
        return;
      }
      submit.disabled = true;
      try {
        const r = await api.sourceDeleteInvalid(ids ? { ids } : currentFilter());
        if (r.deleted) {
          toastOk('已删除 ' + r.deleted + ' 个失效书源');
          state.selected.clear();
        } else {
          toast('没有可删除的失效书源');
        }
        await updateListBadges();
      } catch (err) {
        toastError(err, '清理失败');
      } finally {
        submit.disabled = false;
      }
    });
  }

  async function batchPatch(patch) {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    try {
      await api.sourceBatch(ids, patch);
      toastOk('已更新 ' + ids.length + ' 个书源');
      state.selected.clear();
      reload();
    } catch (err) { toastError(err, '批量操作失败'); }
  }

  async function editGroup(ids) {
    const val = await promptDialog({
      title: '移动到分组',
      label: '分组名称（留空表示未分组）',
      value: '',
      placeholder: '例如：精品源',
      datalist: state.groups,
    });
    if (val === null) return;
    try {
      await api.sourceBatch(ids, { group: val });
      toastOk('已移动 ' + ids.length + ' 个书源');
      state.selected.clear();
      reload();
    } catch (err) { toastError(err, '移动失败'); }
  }

  async function deleteSources(ids, name) {
    const ok = await confirmDialog(
      name ? '确定删除书源「' + name + '」吗？此操作不可恢复。' : '确定删除选中的 ' + ids.length + ' 个书源吗？此操作不可恢复。',
      { danger: true, okLabel: '删除' }
    );
    if (!ok) return;
    try {
      if (ids.length === 1) await api.sourceDelete(ids[0]);
      else await api.sourceBatchDelete(ids);
      toastOk('已删除');
      state.selected.clear();
      reload();
    } catch (err) { toastError(err, '删除失败'); }
  }

  /* ---------------- 导出 ---------------- */

  function doExport(ids) {
    const list = ids && ids.length ? ids : Array.from(state.selected);
    const url = api.sourceExportUrl(list);
    try {
      const a = h('a', { href: url, download: 'sources.json', style: { display: 'none' } });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
      toast('已开始下载' + (list.length ? '（' + list.length + ' 个）' : '（全部）'));
    } catch (err) {
      toastErr('导出失败');
    }
  }

  /* ---------------- 导入 ---------------- */

  function openImport() {
    let mode = 'append';
    let group = '';

    const tabs = h('div', { class: 'import-tabs' });
    const bodyBox = h('div', {});
    let activeTab = 'text';

    const textArea = h('textarea', { class: 'textarea', placeholder: '粘贴书源 JSON（支持单个对象、数组或 {"bookSources":[...]}）' });
    const urlInput = h('input', { class: 'input', type: 'text', placeholder: '订阅地址，例如 https://example.com/sources.json' });
    const fileInput = h('input', { class: 'input', type: 'file', accept: '.json,application/json' });
    const fileInfo = h('p', { class: 'form-hint', text: '选择本地 .json 文件后会自动读取内容，按「文本导入」的方式提交。' });

    const textPane = h('div', {}, textArea);
    const urlPane = h('div', {}, h('p', { class: 'form-hint', style: { marginBottom: '8px' }, text: '从网络地址导入（支持订阅链接，服务端会下载并解析）。' }), urlInput);
    const filePane = h('div', {}, fileInput, fileInfo);

    const panes = { text: textPane, url: urlPane, file: filePane };

    function syncTabs() {
      Array.from(tabs.children).forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
      for (const key of Object.keys(panes)) panes[key].style.display = key === activeTab ? '' : 'none';
    }
    [['text', '粘贴文本'], ['url', '网络地址'], ['file', '本地文件']].forEach(([key, label]) => {
      const btn = h('button', { class: 'chip', type: 'button', text: label, dataset: { tab: key }, on: { click: () => { activeTab = key; syncTabs(); } } });
      tabs.appendChild(btn);
    });
    syncTabs();

    const modeSelect = h('select', { class: 'select input-sm', style: { width: 'auto' }, on: { change: () => { mode = modeSelect.value; } } });
    [['append', '追加（全部新增）'], ['merge', '合并（同名同址则更新）'], ['replace', '替换（清空后导入）']].forEach(([v, l]) => modeSelect.appendChild(h('option', { value: v, text: l })));

    const groupInput = h('input', { class: 'input input-sm', type: 'text', placeholder: '指定分组（可留空）', list: 'import-group-list', on: { change: () => { group = groupInput.value.trim(); } } });
    const dl = h('datalist', { id: 'import-group-list' });
    state.groups.forEach((gname) => dl.appendChild(h('option', { value: gname })));

    const resultBox = h('div', { class: 'import-result', style: { display: 'none' } });

    const body = h('div', {},
      tabs,
      bodyBox,
      h('div', { class: 'form-row', style: { marginTop: '14px' } },
        h('label', { class: 'form-label', text: '导入方式' }), modeSelect),
      h('div', { class: 'form-row' },
        h('label', { class: 'form-label', text: '导入分组' }), groupInput, dl),
      resultBox
    );
    bodyBox.appendChild(textPane);
    bodyBox.appendChild(urlPane);
    bodyBox.appendChild(filePane);

    const submitBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '开始导入', on: { click: () => submit() } });
    const handle = openModal({ title: '导入书源', size: 'md', body, footer: [
      h('button', { class: 'btn btn-ghost', type: 'button', text: '关闭', on: { click: () => handle.close() } }),
      submitBtn,
    ] });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        textArea.value = String(reader.result || '');
        fileInfo.textContent = '已读取文件「' + file.name + '」（' + Math.round(file.size / 1024) + ' KB），点「开始导入」提交。';
      };
      reader.onerror = () => toastErr('读取文件失败');
      reader.readAsText(file, 'utf-8');
    });

    async function submit() {
      submitBtn.disabled = true;
      submitBtn.textContent = '导入中…';
      resultBox.style.display = 'none';
      try {
        let data;
        if (activeTab === 'url') {
          const url = urlInput.value.trim();
          if (!url) { toastWarn('请填写网络地址'); return; }
          data = await api.sourceImportUrl({ url, mode, group });
        } else {
          const text = textArea.value.trim();
          if (!text) { toastWarn('请粘贴书源 JSON 或选择文件'); return; }
          data = await api.sourceImport({ text, mode, group });
        }
        showImportResult(data);
        toastOk('导入完成');
        state.selected.clear();
        await reload();
      } catch (err) {
        toastError(err, '导入失败');
        clear(resultBox);
        resultBox.style.display = '';
        resultBox.appendChild(h('div', { class: 'line', style: { color: 'var(--ui-danger)' }, text: '导入失败：' + (err.message || '未知错误') }));
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '开始导入';
      }
    }

    function showImportResult(data) {
      const d = data || {};
      clear(resultBox);
      resultBox.style.display = '';
      resultBox.appendChild(h('div', { class: 'line' }, h('strong', { text: '导入结果' })));
      resultBox.appendChild(h('div', { class: 'line' }, h('span', { text: '总计 ' + (d.total || 0) + ' 条' })));
      resultBox.appendChild(h('div', { class: 'line' }, h('span', { class: 'badge badge-ok', text: '新增 ' + (d.added || 0) }), h('span', { class: 'badge badge-primary', text: '更新 ' + (d.updated || 0) }), h('span', { class: 'badge', text: '跳过 ' + (d.skipped || 0) }), h('span', { class: 'badge badge-err', text: '失败 ' + ((d.failed && d.failed.length) || 0) })));
      if (d.failed && d.failed.length) {
        const ul = h('ul', { class: 'fail-list' });
        for (const f of d.failed.slice(0, 100)) {
          ul.appendChild(h('li', { text: (f.name || '未命名') + '：' + (f.error || '未知错误') }));
        }
        resultBox.appendChild(ul);
      }
    }
  }

  /* ---------------- 书源测试 ---------------- */

  async function testSource(src) {
    const body = h('div', {}, loadingBlock('正在真实搜索一次，请稍候…'));
    const handle = openModal({ title: '测试书源 · ' + (src.name || ''), size: 'md', body });
    const started = Date.now();
    try {
      const data = await api.sourceTest(src.id);
      clear(body);
      const d = data || {};
      body.appendChild(h('div', { class: 'cache-stat' },
        statItem(String(d.count || 0), '命中条数'),
        statItem(formatDuration(d.elapsed === undefined ? (Date.now() - started) : d.elapsed), '耗时'),
        statItem(d.ok ? '成功' : '失败', '状态')
      ));
      if (d.error) {
        body.appendChild(h('p', { style: { color: 'var(--ui-danger)', marginTop: '10px' }, text: '错误：' + d.error }));
      }
      const samples = Array.isArray(d.samples) ? d.samples.slice(0, 3) : [];
      body.appendChild(h('h4', { style: { margin: '14px 0 8px', fontSize: '14px' }, text: '样例结果（最多 3 条）' }));
      if (!samples.length) {
        body.appendChild(h('p', { class: 'muted small', text: '没有样例数据' }));
      } else {
        for (const s of samples) {
          body.appendChild(h('div', { class: 'alt-item' },
            h('div', { class: 'alt-main' },
              h('div', { style: { fontWeight: '600' }, text: s.name || '未命名' }),
              h('div', { class: 'small muted nowrap', text: (s.author || '佚名') + ' · ' + (s.bookUrl || '') })
            )
          ));
        }
      }
      const logs = Array.isArray(d.log) ? d.log : [];
      body.appendChild(h('h4', { style: { margin: '14px 0 8px', fontSize: '14px' }, text: '执行日志' }));
      const logBox = h('div', { class: 'test-log', text: logs.length ? logs.join('\n') : '（无日志）' });
      body.appendChild(logBox);
    } catch (err) {
      clear(body);
      body.appendChild(errorState(err, () => { handle.close(); testSource(src); }));
    }
  }

  function statItem(num, label) {
    return h('div', { class: 'item' }, h('span', { class: 'num', text: num }), h('span', { class: 'lbl', text: label }));
  }

  /* ---------------- 启动 ---------------- */
  await reload();

  return function cleanup() {
    if (state.observer) state.observer.disconnect();
  };
}

export default render;
