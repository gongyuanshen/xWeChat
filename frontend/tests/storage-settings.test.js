import { mount, flushPromises } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import StorageSettings from '../components/StorageSettings.vue';

const state = vi.hoisted(() => ({ accounts: null, privacy: null }));
vi.mock('~/stores/chatAccounts', () => ({ useChatAccountsStore: () => state.accounts }));
vi.mock('~/stores/privacy', () => ({ usePrivacyStore: () => ({ privacyMode: state.privacy }) }));
vi.mock('pinia', () => ({ storeToRefs: store => store }));
let wrapper, request;
const summary = (account = 'account-a', bytes = 1024) => ({ account, total_bytes: 8192,
  categories: [{ id: 'databases', label: '数据库', bytes: 7168, files: 2, description: '聊天原文', locations: [{ path: `D:\\资料\\databases\\${account}`, kind: 'directory' }] }, { id: 'indexes', label: '搜索索引', bytes, files: 1, description: '可重建', locations: bytes ? [{ path: `D:\\资料\\databases\\${account}`, kind: 'directory' }] : [] }],
  cleanup: { category: 'search_index', available: bytes > 0, bytes, files: 1, reason: bytes ? '' : '没有可清理的搜索索引。' },
  sync: { enabled: false, running: false, user_paused: false, refresh_available: false, unavailable_reason: '未绑定本机微信数据', phase: 'disabled' },
  shared: { bytes: 4096, description: '共享 AI 数据', locations: [{ path: 'D:\\资料\\ai', kind: 'directory' }] }, scope_note: '仅统计本应用管理的文件。' });
const button = text => wrapper.findAll('button').find(item => item.text() === text);
const open = async (active = true) => { wrapper = mount(StorageSettings, { props: { active } }); await flushPromises(); };
beforeEach(() => {
  state.accounts = reactive({ accounts: ['account-a', 'account-b'], selectedAccount: 'account-a', error: '' });
  state.privacy = ref(false);
  request = vi.fn(async () => summary());
  vi.stubGlobal('useApiBase', () => '/api'); vi.stubGlobal('$fetch', request);
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });

it('scans only when the storage section is opened and keeps shared data separate', async () => {
  await open(false); expect(request).not.toHaveBeenCalled();
  await wrapper.setProps({ active: true }); await flushPromises();
  expect(request).toHaveBeenCalledWith('/api/storage', expect.objectContaining({ query: { account: 'account-a' }, retry: 0 }));
  expect(wrapper.text()).toContain('共享 AI 数据'); expect(wrapper.text()).toContain('8.00 KB');
});
it('ignores an old account response and aborts its scan', async () => {
  let finish;
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await open(); const signal = request.mock.calls[0][1].signal;
  request.mockResolvedValue(summary('account-b'));
  await wrapper.find('select').setValue('account-b'); await flushPromises();
  finish({ ...summary(), scope_note: '旧账号内容' }); await flushPromises();
  expect(signal.aborted).toBe(true); expect(wrapper.text()).not.toContain('旧账号内容');
});
it('requires explicit confirmation and refreshes after one successful cleanup request', async () => {
  await open(); await button('清理搜索索引…').trigger('click');
  expect(request).toHaveBeenCalledTimes(1); expect(wrapper.text()).toContain('下次搜索需要重新建立索引');
  request.mockResolvedValueOnce({ removed_bytes: 1024, removed_files: 1 }).mockResolvedValueOnce(summary('account-a', 0));
  await button('确认清理').trigger('click'); await flushPromises();
  expect(request.mock.calls[1]).toEqual(['/api/storage/cleanup', expect.objectContaining({ method: 'POST', body: { category: 'search_index' }, query: { account: 'account-a' }, retry: 0 })]);
  expect(wrapper.text()).toContain('已清理 1 个索引文件');
  expect(request).toHaveBeenCalledTimes(3);
});
it('reports partial failure without success and does not retry the deletion', async () => {
  await open(); await button('清理搜索索引…').trigger('click');
  request.mockRejectedValueOnce({ data: { detail: { message: '文件被占用', removed_bytes: 512, removed_files: 1 } } });
  await button('确认清理').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('文件被占用'); expect(wrapper.text()).toContain('本次已删除 1 个文件');
  expect(wrapper.text()).not.toContain('已清理'); expect(request).toHaveBeenCalledTimes(2);
  expect(button('清理搜索索引…')).toBeUndefined();
});
it('shows a busy reason and disables cleanup', async () => {
  const data = summary(); data.cleanup.available = false; data.cleanup.reason = '账号有任务正在运行，请结束后刷新。';
  request.mockResolvedValue(data); await open();
  expect(wrapper.text()).toContain('账号有任务正在运行'); expect(button('清理搜索索引…').attributes('disabled')).toBeDefined();
});
it('preserves confirmed cleanup outcome if the subsequent statistics request fails', async () => {
  await open(); await button('清理搜索索引…').trigger('click');
  request.mockResolvedValueOnce({ removed_bytes: 1024, removed_files: 1 }).mockRejectedValueOnce(new Error('统计读取失败'));
  await button('确认清理').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('已清理 1 个索引文件'); expect(wrapper.text()).toContain('统计读取失败');
});
it('does not treat a dropped response as successful or automatically repeat cleanup', async () => {
  await open(); await button('清理搜索索引…').trigger('click');
  request.mockRejectedValueOnce(new Error('连接已断开'));
  await button('确认清理').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('清理结果未确认'); expect(wrapper.text()).toContain('刷新占用核对');
  expect(request).toHaveBeenCalledTimes(2); expect(wrapper.text()).not.toContain('已清理');
});
it('does not scan when there is no account and starts once accounts finish loading', async () => {
  state.accounts.accounts = []; state.accounts.selectedAccount = null;
  await open(); expect(request).not.toHaveBeenCalled();
  state.accounts.accounts = ['account-b']; request.mockResolvedValue(summary('account-b'));
  await flushPromises();
  expect(request).toHaveBeenCalledWith('/api/storage', expect.objectContaining({ query: { account: 'account-b' } }));
});
it('pauses synchronization only on request and offers explicit resume after cleanup', async () => {
  const running = summary(); running.sync = { enabled: true, running: false, user_paused: false, refresh_available: true, phase: 'waiting' };
  running.cleanup.available = false;
  request.mockResolvedValueOnce(running); await open();
  expect(request).toHaveBeenCalledTimes(1);
  const paused = summary(); paused.sync = { ...running.sync, enabled: false, user_paused: true, phase: 'stopped' };
  request.mockResolvedValueOnce({ account: 'account-a', user_paused: true }).mockResolvedValueOnce(paused);
  await button('暂停自动同步').trigger('click'); await flushPromises();
  expect(request.mock.calls[1]).toEqual(['/api/decrypt/snapshot-refresh/stop', expect.objectContaining({ method: 'POST', body: { account: 'account-a', user_paused: true }, retry: 0 })]);
  expect(button('恢复自动同步')).toBeDefined();
  request.mockResolvedValueOnce({ account: 'account-a', user_paused: false }).mockResolvedValueOnce(running);
  await button('恢复自动同步').trigger('click'); await flushPromises();
  expect(request.mock.calls[3]).toEqual(['/api/decrypt/snapshot-refresh/start', expect.objectContaining({ method: 'POST', body: { account: 'account-a', resume: true, interval_seconds: 30 }, retry: 0 })]);
  expect(request.mock.calls.filter(([url]) => url.endsWith('/cleanup'))).toHaveLength(0);
});
it('does not automatically repeat an unconfirmed pause command', async () => {
  const running = summary(); running.sync = { enabled: true, running: true, user_paused: false, refresh_available: true, phase: 'building' };
  request.mockResolvedValueOnce(running); await open(); request.mockRejectedValueOnce(new Error('连接中断'));
  await button('暂停自动同步').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('操作结果未确认'); expect(request).toHaveBeenCalledTimes(2);
});

it('shows main folder locations for each category and shared data without a second request', async () => {
  const data = summary();
  data.categories.push({ id: 'media', label: '媒体与附件', bytes: 1024, files: 2, locations: [{ path: 'D:\\资料\\databases\\account-a\\resource', kind: 'directory' }] });
  request.mockResolvedValue(data); await open();
  expect(wrapper.findAll('summary').map(item => item.text())).toEqual(['查看存放位置', '查看存放位置', '查看存放位置', '查看存放位置']);
  expect(wrapper.findAll('code').map(item => item.text())).toEqual([
    'D:\\资料\\databases\\account-a',
    'D:\\资料\\databases\\account-a',
    'D:\\资料\\databases\\account-a\\resource',
    'D:\\资料\\ai',
  ]);
  expect(wrapper.findAll('details').every(item => !item.element.open)).toBe(true);
  expect(wrapper.text()).toContain('文件夹'); expect(request).toHaveBeenCalledTimes(1);
});

it('shows an empty location state instead of inventing a directory', async () => {
  const data = summary('account-a', 0); data.shared.locations = [];
  request.mockResolvedValue(data); await open();
  expect(wrapper.text()).toContain('尚无本分类文件');
  expect(wrapper.text()).toContain('尚无共享数据文件');
  expect(wrapper.findAll('code')).toHaveLength(1);
});

it('copies the exact address and confirms only after the clipboard succeeds', async () => {
  let finish;
  const writeText = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await open(); await button('复制地址').trigger('click');
  expect(writeText).toHaveBeenCalledWith('D:\\资料\\databases\\account-a');
  expect(button('已复制')).toBeUndefined();
  finish(); await flushPromises();
  expect(button('已复制')).toBeDefined();
});

it('reports clipboard failure without a copied state or automatic retry', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('剪贴板被拒绝'));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await open(); await button('复制地址').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('无法复制地址：剪贴板被拒绝');
  expect(button('已复制')).toBeUndefined(); expect(writeText).toHaveBeenCalledTimes(1);
});

it('discards a late clipboard result when the account changes', async () => {
  let finish;
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => new Promise(resolve => { finish = resolve; })) } });
  await open(); await button('复制地址').trigger('click');
  request.mockResolvedValue(summary('account-b'));
  await wrapper.find('select').setValue('account-b'); await flushPromises();
  finish(); await flushPromises();
  expect(wrapper.findAll('code').map(item => item.text()).join('\n')).not.toContain('account-a');
  expect(button('已复制')).toBeUndefined();
});

it('keeps personal paths blurred in privacy mode', async () => {
  state.privacy.value = true;
  await open();
  expect(wrapper.findAll('.storage-location-address').every(item => item.classes().includes('privacy-blur'))).toBe(true);
});
