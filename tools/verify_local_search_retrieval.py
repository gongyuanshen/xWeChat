"""可复现的合成标注集：真实 FTS5、sqlite-vec、ONNX 与 RRF，不读取私人记录。"""
import json
import os
from pathlib import Path
import sqlite3
import statistics
import time
os.environ['HF_HUB_OFFLINE']='1'

CASES=[
    ('延期','供应商说这周做不完，要下周二才能交付。'),
    ('预算多少钱','这份合同最终谈到了三万五千元，含税。'),
    ('聚餐在哪','周五晚上七点去海底捞，位置已经订好了。'),
    ('服务器故障','机器一直报错，接口连接不上，业务已经停了。'),
    ('AB-2026-058','请核对订单 AB-2026-058 的发货地址。'),
    ('35000','采购单的总金额为 35000 元整。'),
    ('refund','The customer requests their money back for the cancelled booking.'),
    ('meeting rescheduled','The team will gather on Thursday instead of Monday.')]
NOISE=['今天下雨，记得带伞。','猫咪趴在窗边睡觉。','这本小说结局很有趣。','早餐吃了两个包子。',
       '去公园跑了五公里。','新买的台灯很好看。','球赛打到了加时。','明天给花浇点水。',
       '刚收拾完书桌。','天气预报说周末转晴。','这首歌的旋律很好听。','晚上看一部电影吧。',
       '水果店的苹果很甜。','The mountain trail is beautiful.','A little bird is singing outside.',
       '厨房的水龙头修好了。','衣服洗完晾在阳台。','地铁今天人很多。','牙刷记得换新的。','照片拍得不错。']

def main():
    import psutil
    from wechat_decrypt_tool.chat_helpers import _build_fts_query,_to_char_token_text
    from wechat_decrypt_tool.local_search.catalog import model_spec,model_dir
    from wechat_decrypt_tool.local_search.inference import LocalInference
    from wechat_decrypt_tool.local_search.index import SemanticIndex,fuse
    root=Path(__file__).resolve().parents[1]/'tmp/local-search-validation'
    texts=[t for _,t in CASES]+NOISE+[f'第 {i+1} 次记录：{t}' for i,t in enumerate(NOISE)]
    messages=[dict(source=str(i),anchor=str(i),username='synthetic',sender='sample',time=1000+i*1000,kind='text',text=t) for i,t in enumerate(texts)]
    db=sqlite3.connect(':memory:');db.execute('CREATE VIRTUAL TABLE fts USING fts5(text)')
    for m in messages:db.execute('INSERT INTO fts(rowid,text) VALUES(?,?)',(int(m['source'])+1,_to_char_token_text(m['text'])))
    engine=LocalInference();records=[]
    try:
        for id in ['bge-small-zh','bge-base-zh','e5-small']:
            spec=model_spec(id);path=model_dir(root/'models',id);began=time.monotonic();vectors=[]
            for offset in range(0,len(texts),8):vectors.extend(engine.encode(path,spec,texts[offset:offset+8],'cpu'))
            index_time=time.monotonic()-began
            index=SemanticIndex(root/f'evaluation-{id}.sqlite3');index.clear()
            index.commit('test',messages,[dict(text=m['text'],sources=[m['source']],username=m['username']) for m in messages],vectors,{'id':'fixture'})
            scores=[];latencies=[]
            for expected,(q,_) in enumerate(CASES):
                began=time.monotonic()
                vector=engine.encode(path,spec,[q],'cpu',query=True)[0]
                keyword=[dict(id=str(r[0]-1),username='synthetic') for r in db.execute('SELECT rowid FROM fts WHERE fts MATCH ? LIMIT 200',(_build_fts_query(q),))]
                semantic=[dict(id=r['message']['source'],username='synthetic') for r in index.search('test',vector,['synthetic'])]
                mixed=fuse(keyword,semantic)
                scores.append({'query':q,'keyword_recall20':int(str(expected) in {x['id'] for x in keyword[:20]}),'hybrid_recall20':int(str(expected) in {x['id'] for x in mixed[:20]})})
                latencies.append(time.monotonic()-began)
            record={'model':id,'messages':len(messages),'queries':len(CASES),'keyword_recall20':statistics.mean(x['keyword_recall20'] for x in scores),
                    'hybrid_recall20':statistics.mean(x['hybrid_recall20'] for x in scores),'index_seconds':index_time,
                    'query_median_ms':statistics.median(latencies)*1000,'worker_rss_mb':psutil.Process(engine.process.pid).memory_info().rss/1024**2,'cases':scores}
            records.append(record);print(json.dumps(record,ensure_ascii=False),flush=True)
        (root/'retrieval-results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    finally:engine.close()

if __name__=='__main__':main()
