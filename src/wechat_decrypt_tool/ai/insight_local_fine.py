"""Fine Laya decisions adapted from WechatVibe generic-v9, Apache-2.0.

Lexical cues retrieve options only. Every displayed classification and score
comes from the model. See resources/licenses/wechatvibe-NOTICE.txt.
"""
from __future__ import annotations

import math
import re

from .insight_local import message_state
from .laya_runtime import LayaInputError, LayaOutputError

FINE_VERSION = 'laya-fine-v1-generic-v9'

INTENTS = {
    'small_talk': '闲聊',
    'share_news': '分享',
    'ask_question': '提问',
    'seek_help': '求助',
    'give_comfort': '安慰',
    'agree': '同意',
    'invite': '邀约',
    'show_affection': '表达好感',
    'complain': '抱怨',
    'apologize': '道歉',
    'joke': '玩笑',
    'reject': '拒绝',
    'deny': '否认',
    'distance': '保持距离',
    'thank': '感谢',
    'greet': '问候',
    'suggest_action': '建议指令',
    'explain': '解释',
    'inform': '告知事实',
    'plan': '计划',
    'correct': '纠正异议',
    'status_report': '状态报告',
    'confirm': '确认',
    'inspect': '查看',
    'follow_up': '追问',
    'clarify': '澄清',
    'share_feeling': '表达感受',
    'confide': '倾诉',
    'seek_comfort': '求安慰',
    'seek_company': '求陪伴',
    'show_care': '关心',
    'encourage': '鼓励',
    'praise': '称赞',
    'celebrate': '祝贺',
    'miss_you': '表达想念',
    'test_feelings': '试探',
    'set_boundary': '设定边界',
    'reconcile': '缓和关系',
    'show_material': '展示内容',
    'offer_help': '提供帮助',
    'tease': '调侃',
    'close_chat': '告别',
    'general_exchange': '一般交流',
    'soft_decline': '婉拒',
    'perfunctory': '敷衍',
    'promise': '承诺',
    'negotiate': '协商',
}

CUES = [
    (re.compile('不去了|不参加|没法去|接不了|去不了|没空|不要了|不愿意|我拒绝|不接受|我不同意|(?:我们|咱们|两个人|彼此).{0,4}不(?:太)?合适'), ('reject', 'distance')),
    (re.compile('(?:^|[，,。！!\\s])(?:那|我)?还是算了(?:吧)?(?=$|[，,。！!\\s])'), ('reject',)),
    (re.compile('别再|不要再|先别|不想谈|(?:我们|咱们|这段关系|这次聊天|这个话题).{0,4}到此为止|需要.{0,4}空间|保持距离'), ('set_boundary', 'distance')),
    (re.compile('对不起|抱歉|不好意思|是我不对|我错了'), ('apologize', 'reconcile')),
    (re.compile('和好|别生气|我们好好说|不想吵|重新开始'), ('reconcile', 'clarify')),
    (re.compile('安慰我|哄哄我|给我点鼓励|想听你安慰|能不能听我说'), ('seek_comfort', 'confide')),
    (re.compile('陪陪我|陪我聊|想有人陪|别走|留下来陪'), ('seek_company', 'seek_comfort')),
    (re.compile('别(?:太)?难过|别(?:再)?生气|不要生气|别哭|放心|没事的|会好起来|别担心|不用怕|我(?:会|来)?陪你|我会陪你.{0,12}(?:处理|面对|度过)|慢慢来.{0,8}我陪你'), ('give_comfort',)),
    (re.compile('心里.{0,8}(?:难受|委屈|烦|苦)|有点(?:难过|委屈|伤心)|想跟你说|想找你聊|想聊聊|说说心里话|我很焦虑'), ('confide', 'share_feeling')),
    (re.compile('你(?:是不是|还)?(?:喜欢|在乎|想|爱)我|你对我.{0,6}(?:感觉|想法)|我们算什么|你会不会想我'), ('test_feelings', 'show_affection')),
    (re.compile('想你|思念你|好久不见|惦记你'), ('miss_you', 'show_affection')),
    (re.compile('喜欢你|爱你|有你真好|对你心动'), ('show_affection', 'miss_you')),
    (re.compile('还好吗|累不累|吃饭了吗|早点休息|注意身体|照顾好自己|到家了吗'), ('show_care',)),
    (re.compile('别担心|不用怕|没关系|会好起来|我陪着你'), ('give_comfort', 'show_care')),
    (re.compile('加油|别灰心|相信你|你能行|坚持住'), ('encourage', 'give_comfort')),
    (re.compile('真厉害|做得好|太棒了|佩服你|真优秀|真好看|你.{0,8}(?:不错|漂亮|好看|太牛|厉害)|(?:真|太|特别)(?:棒|牛|厉害|漂亮)'), ('praise', 'show_affection')),
    (re.compile('恭喜|祝贺|生日快乐|新年快乐'), ('celebrate', 'show_care')),
    (re.compile('我帮你|需要我帮|我来帮|我可以帮|交给我'), ('offer_help',)),
    (re.compile('给你看|发你|截图|照片|图片|视频|文件|链接|资料|附件|录屏'), ('show_material', 'share_news')),
    (re.compile('真无语|太离谱|受不了|烦死|讨厌|怎么.{0,8}还|等了.{0,12}还没'), ('complain', 'share_feeling')),
    (re.compile('不理我|不回我|不搭理我'), ('complain', 'seek_comfort')),
    (re.compile('哈哈|笑死|逗你|开个玩笑|闹着玩|别当真|骗你的'), ('tease', 'joke')),
    (re.compile('^(?:谢谢|谢了|感谢|多谢)|(?:谢谢|谢了|感谢|多谢)(?:你|您|你们|大家|各位|老师|同学|朋友|宝贝|啦|了|啊|呀|哦|哈|[，,。！!\\s]|$)|辛苦(?:了|大家|各位|你们|老师)|感激不尽'), ('thank', 'show_care')),
    (re.compile('^(?:你好|嗨|哈喽|早安|早上好|晚安|晚上好|hello|hi)(?:[，,!！。\\s]|$)', re.IGNORECASE), ('greet', 'close_chat')),
    (re.compile('你好(?!吃|看)|您好|早上好|下午好|晚上好|早安|晚安'), ('greet',)),
    (re.compile('拜拜|再见|明天见|回见|下次见|回头见|先挂了|我走了|不聊了|回头聊|先这样|下次聊'), ('close_chat', 'small_talk')),
    (re.compile('^(?:嗯|好[的呀啊了]?|可以[的呀啊]?|行[的呀啊]?|没问题|当然可以|同意|OK|ok)(?:[，,.!！。\\s]|$)'), ('agree', 'confirm')),
    (re.compile('收到|明白了|知道了|确认一下|没错'), ('confirm', 'agree')),
    (re.compile('我(?:先)?(?:看(?:看|一下)|查(?:看|一下))|我去看看'), ('inspect', 'plan')),
    (re.compile('要不要.{0,12}(?:一起|去|来)|(?:我们|咱们|一起).{0,8}(?:去|来|吃|喝|玩|看|逛|见|聚|聊|打球)|约(?:个|你|我|在)'), ('invite', 'plan')),
    (re.compile('帮我|帮忙|能不能.{0,8}(?:弄|看|改|做)|麻烦(?:你|您)|请(?:你|您)|(?:告诉|发给|给)我|把.{1,20}给我'), ('seek_help', 'ask_question')),
    (re.compile('不是.{0,30}而是|不是的|当然不是|不对|应该是|你说的不对|我不同意|我不赞成'), ('correct', 'clarify')),
    (re.compile('我的意思|我说的是|换句话说|澄清一下|解释一下'), ('clarify', 'explain')),
    (re.compile('因为|由于|原因是|是因为|意味着|也就是说'), ('explain', 'inform')),
    (re.compile('换个话题|说点别的|话说回来'), ('small_talk', 'clarify')),
    (re.compile('后来呢|然后呢|你刚才说|再说说|所以呢|对不对|你知道吧'), ('follow_up', 'ask_question')),
    (re.compile('打算|计划|准备|(?:我|我们|咱们)(?:今天|明天|后天|明早|今晚|周末|下周|下个月|改天|过几天).{0,12}(?:去|做|见|吃|看|打|联系|上班|回家)'), ('plan',)),
    (re.compile('已经|正在|进行中|还没|尚未|完成|修好了|成功了|失败了'), ('status_report', 'inform')),
    (re.compile('推荐|你(?:可以|不妨)|可以(?:去|看|试|任?选)|任选(?:一个|一家)|(?:你|您).{0,40}选择.{0,12}吧|(?:你|您)自己选(?:定)?吧|(?:很好|不错|合适)的选择|都(?:还)?挺不错|都还不错|符合.{0,12}(?:要求|标准)|这些.{0,8}可以选择|看(?:你|您)喜欢哪个|挑一个'), ('suggest_action', 'offer_help')),
    (re.compile('建议|可以先|不妨|最好|要不|试试|^(?:先|把|将|请|麻烦|记得|不要(?!难过|担心|怕)|别(?!太?难过|担心|怕))'), ('suggest_action', 'plan')),
    (re.compile('(?:^|[，,。])我.{0,8}(?:觉得|感觉|开心|高兴|难过|失落|害怕|担心|期待|紧张)'), ('share_feeling', 'confide')),
]

QUOTED = re.compile('“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|`[^`]*`')
QUESTION_CUE = re.compile('[？?]|(?:怎么|为什么|如何|是否|是不是|能否|能不能|多少|几点|几号|几(?:个人|位|楼|件|份|次|辆|本|条|张)|什么|咋(?:样|办|回事|了)|啥(?:时候|情况|意思)|干嘛|哪(?:个|家|里|儿))[^。！!？?]{0,20}(?:[。！!，,\\s]|$)|(?:吗|呢)(?:[。！!，,\\s]|$)|^(?:谁|什么|哪里|哪儿|何时|什么时候|几|多少)')
RHETORICAL_CORRECTION = re.compile('^(?:[^。！？?]{0,12})?这不[^。！？?]{1,50}(?:了|过)吗[？?]?$')
NONQUESTION_SHORT = re.compile('^(?:没什么|没啥)(?:事|意思|好说的)?[。！!\\s]*$')
CARE_CONTINUATION = re.compile('[？?].{0,60}(?:早点休息|好好休息|注意身体|照顾好自己|别太累)')
DIRECTED_CONFIDING = re.compile('想跟你说|想找你聊|想聊聊|说说心里话|能不能听我说')
DENY_CONTEXT = re.compile('喜欢|爱|在乎|想我|暧昧|关系|要不要|是不是|会不会|是否')
INVITE_CONTEXT = re.compile('(?:要不要|一起|约|有空|安排|见面|出来|吃饭|看展|看电影|逛街|聚|来我家|请你|请我|周六|周日|周末|明天|后天|下周|下个月)')
DEFERRAL = re.compile('改天|下次(?!见|聊|再聊|说)|以后再说|再说吧|再约|看情况|看(?:看)?再说|过(?:几|两)天|有空再说|回头(?:再)?(?:说|约)|晚点再说')
CONCRETE_TIME = re.compile('今天|明天|后天|明早|今晚|这周|本周|下周|周末|周[一二三四五六日天]|下个月|月底|月初|\\d{1,2}[号日]')
CONCRETE_PLAN = re.compile('请你|请我|请客|我请|一起|约你|约我|见面|来找我|来找你')

EMOTIONS = (
    '开心', '期待', '温暖', '平静', '惊讶', '疑惑', '委屈', '难过', '生气', '焦虑', '累了',
    '俏皮', '娇嗔', '傲娇', '犹豫', '纠结', '试探', '客套', '尴尬', '戒备', '无奈', '敷衍',
    '烦躁', '吃醋', '坦诚', '随和', '自然', '不明确',
)
EMOTION_INSTRUCTIONS = (
    '判断 TARGET 发送者当前表达的主要情绪或语气，而不是交流动作或对方的心情。'
    '结合前文判断反讽；表情和标点不能单独证明开心。无明显情绪选自然，证据不足选不明确。'
)
INTENT_INSTRUCTIONS = (
    '判断 TARGET 发送者正在做的交流动作。倾诉是主动向对方说自己的困扰，安慰是回应对方难过，'
    '关心是询问或提醒对方近况；求安慰或陪伴须有明确请求。不要根据称呼、引语或隐含关系猜意图；'
    '没有贴切项选一般交流。'
)
EXTRA_CUES = (
    (re.compile(r'保证|我答应|答应你|一定会|肯定会|说到做到|绝不食言'), ('promise',)),
    (re.compile(r'商量|协商|折中|各退一步|要不|改成|换成|能不能'), ('negotiate',)),
    (re.compile(r'^(?:哦|嗯|好吧|随便|都行|你定|再说吧)[。！!？?，,\s]*$'), ('perfunctory', 'confirm')),
)


def intent_question(target_text, context_hint):
    """Upstream candidate retrieval; no candidate receives a rule-based probability."""
    # Unlike upstream's 240-character hint, keep all explicitly supplied context.
    hint = QUOTED.sub(' ', context_hint).strip()
    text = QUOTED.sub(' ', target_text).strip()
    options = ['inform', 'share_news', 'small_talk']
    def add(key):
        if len(options) < 9 and key not in options:
            options.append(key)
    if (not NONQUESTION_SHORT.search(text) and not RHETORICAL_CORRECTION.search(text)
            and QUESTION_CUE.search(text) and not CARE_CONTINUATION.search(text)):
        add('ask_question')
    if RHETORICAL_CORRECTION.search(text):
        add('correct')
        add('clarify')
    if CONCRETE_TIME.search(text) and CONCRETE_PLAN.search(text):
        add('plan')
        add('invite')
    elif INVITE_CONTEXT.search(hint) and DEFERRAL.search(text):
        add('soft_decline')
        add('reject')
    if re.fullmatch(r'(?:木有|没有)[。！!？?\s]*', text) and DENY_CONTEXT.search(hint):
        add('deny')
    for pattern, keys in (*CUES, *EXTRA_CUES):
        if pattern.search(text):
            for key in keys:
                if key != 'share_feeling' or not DIRECTED_CONFIDING.search(text):
                    add(key)
    for key in ('status_report', 'explain', 'share_feeling', 'agree'):
        if len(options) >= 7:
            break
        if key != 'share_feeling' or not DIRECTED_CONFIDING.search(text):
            add(key)
    options.append('general_exchange')
    return dict(type='choice', instructions=INTENT_INSTRUCTIONS, criteria=[INTENTS[key] for key in options])


def _validate_answers(answers, questions):
    """Validate the model boundary once; invalid output must not become an empty label."""
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise LayaOutputError('Fine Laya must return exactly emotion and intent answers')
    for key, question in questions.items():
        answer = answers[key]
        if not isinstance(answer, dict) or answer.get('type') != 'choice':
            raise LayaOutputError(f'Fine Laya {key} answer is not a choice distribution')
        probabilities = answer.get('probabilities')
        if not isinstance(probabilities, dict) or set(probabilities) != set(question['criteria']):
            raise LayaOutputError(f'Fine Laya {key} candidate set changed')
        if any(isinstance(p, bool) or not isinstance(p, (int, float)) or not math.isfinite(p) or not 0 <= p <= 1
               for p in probabilities.values()):
            raise LayaOutputError(f'Fine Laya {key} has an invalid probability')
        # Production Laya reports probabilities rounded to four decimal places.
        if abs(sum(probabilities.values()) - 1) > len(probabilities) * .00005 + 1e-12:
            raise LayaOutputError(f'Fine Laya {key} probabilities do not sum to one')
        choice = answer.get('choice')
        if choice not in probabilities or probabilities[choice] != max(probabilities.values()):
            raise LayaOutputError(f'Fine Laya {key} choice disagrees with its probabilities')


def predict_message(runtime, item, context, portrait=None, *, private_chat=False):
    """Return one source-bound MessageLabel and its auditable decision inputs/outputs.

    The caller selects a saved portrait belonging to this sender and model source.
    Supplied target, context, quote and portrait are kept whole; the runtime raises
    LayaContextOverflow if the complete input does not fit its 1024-token budget.
    """
    if portrait is not None and (not isinstance(portrait, str) or not portrait.strip()):
        raise LayaInputError('Saved portrait must be a nonblank string or None when absent')
    if not isinstance(item['text'], str) or not item['text'].strip():
        raise LayaInputError('Fine Laya requires a nonempty target text, including punctuation')
    if not all(isinstance(label, str) and 0 < len(label) <= 4 for label in (*EMOTIONS, *INTENTS.values())):
        raise LayaInputError('Fine Laya display labels must contain one to four characters')
    questions = {
        'emotion': dict(type='choice', instructions=EMOTION_INSTRUCTIONS, criteria=list(EMOTIONS)),
        'intent': intent_question(item['text'], '\n'.join(other['text'] for other in context)),
    }
    state = message_state(item, context, private_chat=private_chat)
    if portrait is not None:
        state += (f"\n\nSaved portrait for sender_id={item['sender_id']} "
                  '(weak prior only; TARGET text wins; not new evidence; MBTI is not intent):\n' + portrait)
    answers = runtime.predict(state, questions)
    _validate_answers(answers, questions)
    labels, reasons = {}, []
    for key, title in [('emotion', '情绪'), ('intent', '意图')]:
        choice = answers[key]['choice']
        probability = answers[key]['probabilities'][choice]
        labels[key] = choice if probability >= .5 and choice != '不明确' else None
        reason = f'{title}候选「{choice}」模型分值 {probability:.1%}'
        if probability < .5:
            reason += '，未达到 50% 展示阈值'
        elif choice == '不明确':
            reason += '，模型判断证据不足'
        reasons.append(reason)
    label = dict(source=item['source'], **labels, sources=[item['source']],
        reason='本地 Laya 细分类；' + '；'.join(reasons) + '。分类分值不代表心理测量准确率。')
    return {'label': label, 'raw': {'version': FINE_VERSION, 'questions': questions, 'answers': answers}}
