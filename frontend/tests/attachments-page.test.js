import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AttachmentsPage from '../pages/attachments.vue';

const state = vi.hoisted(() => ({ account: null, privacy: null, api: null }));
vi.mock('~/stores/chatAccounts', () => ({ useChatAccountsStore: () => state.account }));
vi.mock('~/stores/privacy', () => ({ usePrivacyStore: () => state.privacy }));
vi.mock('pinia', () => ({ storeToRefs: store => store }));
vi.mock('~/composables/useAttachmentsApi', () => ({ useAttachmentsApi: () => state.api }));
let wrapper, navigation;
const file = (id = 'message_0:Msg_room:1') => ({ id, username: 'room', name: '说明.txt', kind: 'file', conversation_name: '项目组', sender: 'alice', sender_name: 'Alice', create_time: 10, size: 20, extraction: { status: 'not_extracted', text_excerpt: '', text_characters: 0, message: '' } });
const result = (items = [file()], extra = {}) => ({ status: 'success', items, coverage: { message: '正文搜索仅覆盖已提取内容', total_files: 3, complete: 0, partial: 0 }, has_more: false, next_offset: 40, ...extra });
const button = text => wrapper.findAll('button').find(row => row.text() === text);
const open = async () => {
  wrapper = mount(AttachmentsPage, { global: { stubs: { LibrarySaveDialog: { name: 'LibrarySaveDialog', props: ['account', 'item'], template: '<div />' } } } });
  await flushPromises();
};
beforeEach(() => {
  state.account = { selectedAccount: ref('account-a'), error: '', ensureLoaded: vi.fn() };
  state.privacy = { privacyMode: ref(false) };
  state.api = {
    list: vi.fn(async () => result()),
    filters: vi.fn(async () => ({ status: 'success', conversations: [{ value: 'room', label: '项目组' }], senders: [{ value: 'alice', label: 'Alice' }] })),
    extract: vi.fn(), download: vi.fn(), contentUrl: vi.fn(() => '/content'),
  };
  navigation = ref(null);
  vi.stubGlobal('useHead', vi.fn());
  vi.stubGlobal('useState', () => navigation);
  vi.stubGlobal('navigateTo', vi.fn(async () => true));
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('browses without keywords and applies all filters with local calendar bounds', async () => {
  await open();
  expect(state.api.list).toHaveBeenCalledWith('account-a', expect.objectContaining({ q: '', kind: 'all', offset: 0 }), expect.any(AbortSignal));
  const selects = wrapper.findAll('.attachment-filters select');
  await selects[0].setValue('body'); await selects[1].setValue('file'); await selects[2].setValue('room'); await selects[3].setValue('alice');
  await wrapper.find('input[type=search]').setValue('正文');
  const dates = wrapper.findAll('input[type=date]');
  await dates[0].setValue('2026-10-01'); await dates[1].setValue('2026-10-09');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(state.api.list).toHaveBeenLastCalledWith('account-a', expect.objectContaining({ q: '正文', search_in: 'body', kind: 'file', username: 'room', sender: 'alice', start_time: new Date('2026-10-01T00:00:00').getTime() / 1000, end_time: new Date('2026-10-09T23:59:59').getTime() / 1000 }), expect.any(AbortSignal));
  expect(wrapper.text()).toContain('正文搜索仅覆盖已提取内容');
  await dates[0].setValue('2026-10-10'); await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(wrapper.text()).toContain('开始日期不能晚于结束日期');
});

it('ignores stale account and filter results and aborts the pending request', async () => {
  let resolveOld;
  state.api.list.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await open();
  const oldSignal = state.api.list.mock.calls[0][2];
  state.account.selectedAccount.value = 'account-b'; await flushPromises();
  resolveOld(result([{ ...file(), name: '旧账号秘密' }])); await flushPromises();
  expect(oldSignal.aborted).toBe(true);
  expect(wrapper.text()).not.toContain('旧账号秘密');
  await wrapper.find('input[type=search]').setValue('新条件');
  expect(wrapper.findAll('.attachment-row')).toHaveLength(0);
  expect(wrapper.text()).toContain('筛选条件已改变');
});

it('stops after the active extraction and never calls a model or the next file', async () => {
  let finish;
  state.api.list.mockResolvedValue(result([file(), file('message_0:Msg_room:2')]));
  state.api.extract.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await open();
  await button('提取当前页文件正文').trigger('click');
  await button('停止后续提取').trigger('click');
  finish({ status: 'partial', text_excerpt: '已解析文本', text_characters: 5, message: '图片未解析' }); await flushPromises();
  expect(state.api.extract).toHaveBeenCalledTimes(1);
  expect(state.api.extract).toHaveBeenCalledWith('account-a', { username: 'room', anchor: file().id }, expect.any(AbortSignal));
  expect(wrapper.text()).toContain('已停止后续提取');
  expect(wrapper.text()).toContain('正文部分提取');
  expect(wrapper.text()).toContain('图片未解析');
  expect(wrapper.text()).toContain('正文摘录（已提取 5 字）');
});

it('account switch suppresses extraction completion and offers only authoritative save and locate sources', async () => {
  let finish;
  state.api.extract.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await open(); await button('提取正文').trigger('click');
  state.account.selectedAccount.value = 'account-b'; await flushPromises();
  finish({ status: 'complete', text_excerpt: '旧账号正文', text_characters: 5 }); await flushPromises();
  expect(wrapper.text()).not.toContain('旧账号正文');
  await button('加入资料夹').trigger('click');
  expect(wrapper.findComponent({ name: 'LibrarySaveDialog' }).props()).toEqual({ account: 'account-b', item: { kind: 'attachment', source: { username: 'room', anchor: file().id }, title: '说明.txt' } });
  await button('原消息').trigger('click'); await flushPromises();
  expect(navigation.value).toEqual({ kind: 'source', account: 'account-b', username: 'room', anchor: file().id });
});

it('surfaces structured download and extraction failures without success notices', async () => {
  state.api.extract.mockRejectedValue({ data: { detail: { message: '原始文件缺失' } } });
  state.api.download.mockRejectedValue({ data: { detail: { message: '附件无法读取' } } });
  await open(); await button('提取正文').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('原始文件缺失');
  expect(wrapper.text()).toContain('失败 1 项');
  await button('下载').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('附件无法读取');
  expect(wrapper.text()).not.toContain('[object Object]');
});

it('requests the next page using the returned offset and does not preload videos', async () => {
  state.api.list.mockResolvedValueOnce(result([{ ...file(), kind: 'video' }], { has_more: true, next_offset: 40 })).mockResolvedValueOnce(result([file('message_0:Msg_room:41')]));
  await open();
  expect(wrapper.find('video').exists()).toBe(false);
  await button('下一页').trigger('click'); await flushPromises();
  expect(state.api.list).toHaveBeenLastCalledWith('account-a', expect.objectContaining({ offset: 40 }), expect.any(AbortSignal));
  expect(wrapper.text()).toContain('第 2 页');
});

it('retries a failed page without replacing the current page or resetting its offset', async () => {
  state.api.list.mockResolvedValueOnce(result([file()], { has_more: true, next_offset: 40 }))
    .mockRejectedValueOnce(new Error('索引读取失败'))
    .mockResolvedValueOnce(result([{ ...file('message_0:Msg_room:41'), name: '下一页.txt' }]));
  await open(); await button('下一页').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('索引读取失败');
  expect(wrapper.text()).toContain('说明.txt');
  await button('重试本页').trigger('click'); await flushPromises();
  expect(state.api.list).toHaveBeenLastCalledWith('account-a', expect.objectContaining({ offset: 40 }), expect.any(AbortSignal));
  expect(wrapper.text()).toContain('下一页.txt');
  expect(wrapper.text()).not.toContain('索引读取失败');
});

it('shows the actual index failure and skips terminal extraction states in batch', async () => {
  state.api.list.mockResolvedValueOnce(result([], { status: 'index_error', message: '索引文件损坏', index: { build: { error: '具体故障' } } }))
    .mockResolvedValueOnce(result([
      { ...file(), extraction: { status: 'unsupported' } },
      { ...file('message_0:Msg_room:2'), extraction: { status: 'no_text' } },
    ]));
  await open(); expect(wrapper.text()).toContain('索引文件损坏');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(button('提取当前页文件正文').attributes('disabled')).toBeDefined();
  expect(wrapper.text()).toContain('当前筛选范围内共 3 个文件');
});
it.each(['image', 'video'])('gives conditional download guidance when a %s preview fails', async kind => {
  state.api.list.mockResolvedValue(result([{ ...file(), kind }]));
  await open();
  await button('预览').trigger('click');
  await flushPromises();
  await wrapper.find(kind === 'image' ? '.attachment-preview img' : '.attachment-preview video').trigger('error');
  const alert = wrapper.find('.attachment-preview [role=alert]').text();
  expect(alert).toContain('若尚未下载，请先在电脑版微信中打开并下载，再重试');
  expect(alert).toContain('若已下载仍无法预览，请点击“下载”查看具体错误');
  if (kind === 'video') expect(alert).toContain('浏览器也可能不支持此视频编码');
  expect(state.api.download).not.toHaveBeenCalled();
});
