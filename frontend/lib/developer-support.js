import { openMessageExternalUrl } from '~/lib/chat/message-links'

// 高级版与兑换码的获取渠道只在这里维护一份：跳转 URL、提示文案与各处按钮文案都从它拼
export const QQ_GROUP_NUMBER = '1109365501'
// 3 群的入群短链（落地页即群号 1109365501），与 README / 官网的「QQ 交流群」同一个链接
export const QQ_GROUP_JOIN_URL = 'https://qm.qq.com/q/2IB0gvYpYA'

export const DEVELOPER_CONTACT_TITLE = '请进 QQ 3 群咨询群主'
export const DEVELOPER_CONTACT_LABEL = `进 3 群 ${QQ_GROUP_NUMBER}`
export const DEVELOPER_CONTACT_HINT = `进 QQ 3 群 ${QQ_GROUP_NUMBER} 私聊咨询群主获取`

export const FEATURE_UNAVAILABLE_MESSAGE = `当前版本仅展示该功能入口，暂时无法执行。如需使用高级版，请${DEVELOPER_CONTACT_HINT}。`

export const openDeveloperContact = () => openMessageExternalUrl(QQ_GROUP_JOIN_URL)
