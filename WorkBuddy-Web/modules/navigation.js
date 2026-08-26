// 导航切换 + hash 路由：切页更新 URL（#/page），刷新/前进后退按 hash 回到对应页
// 原为 index.html 内联代码，v0.1.95 拆分为独立模块（页面行为保持不变；需在 index.html 全部内联脚本之后加载）
const PAGE_TITLES = {
  tasks: '任务管理',
  overview: '项目总览',
  archive: '文件归档',
  schedule: '日程管理',
  resources: '资源仓库',
  'plugin-community': '插件社区',
  settings: '设置中心',
  team: '团队协作'
};
const topbarTitleEl = document.querySelector('.topbar .title');
// 页面切换唯一入口：切 DOM + 按需拉数据 + 同步 URL hash（fromHash 时跳过 hash 赋值防循环）
function applyPage(page, fromHash = false) {
  if (!PAGE_TITLES[page]) page = 'tasks';
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  const nav = document.querySelector('.nav-item[data-page="' + page + '"]');
  if (nav) nav.classList.add('active');
  document.querySelectorAll('.page').forEach(p => {
    p.hidden = (p.id !== 'page-' + page);
  });
  // 智能详情右栏仅任务管理页显示
  const appEl = document.querySelector('.app');
  if (appEl) appEl.classList.toggle('no-detail', page !== 'tasks');
  if (topbarTitleEl && PAGE_TITLES[page]) topbarTitleEl.textContent = PAGE_TITLES[page];
  // 进入对应页面时按需拉取/刷新数据
  if (page === 'overview') loadOverview();
  if (page === 'archive') loadArchivePage();
  if (page === 'schedule') loadSchedule();
  if (page === 'resources') loadResourcesPage();
  if (page === 'plugin-community') loadPluginCommunity();
  if (page === 'settings') loadSettingsPage();
  if (!fromHash && location.hash !== '#/' + page) location.hash = '#/' + page;
}
// 前进/后退/手动改 URL → 同步页面
window.addEventListener('hashchange', () => {
  const page = String(location.hash || '').replace(/^#\/?/, '');
  if (PAGE_TITLES[page]) applyPage(page, true);
});
document.querySelectorAll('.nav-item').forEach(n => {
  n.addEventListener('click', () => {
    // 占位项（如「团队协作」）：点击后不切换 active、无任何界面变化
    if (n.dataset.inert === 'true') return;
    const page = n.dataset.page;
    if (!page) return;
    applyPage(page);
  });
});
// 初始路由：刷新/直达时按 hash 回到对应页面（默认任务管理）
(function initRoute() {
  const page = String(location.hash || '').replace(/^#\/?/, '');
  applyPage(PAGE_TITLES[page] ? page : 'tasks', true);
})();
