import json, math, urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta
from urllib.parse import quote

NZ = timezone(timedelta(hours=12))
BASE='https://rowing-app-recorder-pwa.vercel.app'
HDR={'Authorization':'Bearer rnz'}
path = r'c:\Users\JohnSt\Desktop\RNZ\Rowing_App\scripts\_w2x-eh-teleport-analysis.json'
jul24 = json.load(open(path, encoding='utf-8'))[1]

def fetch(from_iso, to_iso):
    u = f"/api/history?uniqueId={quote('W2x EH')}&from={quote(from_iso)}&to={quote(to_iso)}"
    req=urllib.request.Request(BASE+u, headers=HDR)
    with urllib.request.urlopen(req,timeout=120) as r:
        return json.loads(r.read().decode())

def haversine_m(a,b,c,d):
    R=6371000
    p1,p2=math.radians(a),math.radians(c)
    dlat,dlon=math.radians(c-a),math.radians(d-b)
    x=math.sin(dlat/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dlon/2)**2
    return 2*R*math.asin(min(1,math.sqrt(x)))

def parse(route):
    pts=[]
    for p in route:
        t_str=p.get('fixTime') or p.get('deviceTime')
        t_ms=int(datetime.fromisoformat(t_str.replace('Z','+00:00')).timestamp()*1000)
        pts.append({'t_ms':t_ms,'lat':float(p['latitude']),'lon':float(p['longitude']),'acc':p.get('accuracy'),'speed':p.get('speed')})
    pts.sort(key=lambda x:x['t_ms'])
    return pts

for label, from_iso, to_iso in [('Jul23','2026-07-23T06:00:00+12:00','2026-07-23T12:00:00+12:00'),('Jul24','2026-07-24T06:00:00+12:00','2026-07-24T12:00:00+12:00')]:
    pts=parse(fetch(from_iso,to_iso))
    gaps=[round((pts[i]['t_ms']-pts[i-1]['t_ms'])/1000,3) for i in range(1,len(pts))]
    gc=Counter(gaps)
    near1=sum(v for k,v in gc.items() if 0.9<=k<=1.1)
    near2=sum(v for k,v in gc.items() if 1.9<=k<=2.1)
    near3=sum(v for k,v in gc.items() if 2.9<=k<=3.1)
    print(label,'points',len(pts),'gaps ~1s',near1,'~2s',near2,'~3s',near3,'median_gap',sorted(gaps)[len(gaps)//2])
    speeds=[float(p['speed']) for p in pts if p['speed'] is not None]
    print('  speed median/max', round(sorted(speeds)[len(speeds)//2],2), round(max(speeds),2))

pts=parse(fetch('2026-07-24T06:00:00+12:00','2026-07-24T12:00:00+12:00'))
spikes=jul24['all_spikes50']
bounce=0
for s in spikes:
    i=s['i']
    if i+1 < len(pts):
        d_back=haversine_m(pts[i-1]['lat'],pts[i-1]['lon'],pts[i+1]['lat'],pts[i+1]['lon'])
        if d_back < 30 and s['dist_m'] > 50:
            bounce += 1
acc_spike=[max(float(s['acc'] or 0), float(s['acc_prev'] or 0)) for s in spikes]
speed_spike=[float(s['speed'] or 0) for s in spikes]
print('Jul24 spikes50',len(spikes),'bounce_back_next_pt',bounce,'pct',round(100*bounce/len(spikes),1))
print(' acc at spikes min/med/p90/max', round(min(acc_spike),1), round(sorted(acc_spike)[len(acc_spike)//2],1), round(sorted(acc_spike)[int(len(acc_spike)*0.9)],1), round(max(acc_spike),1))
print(' speed at spikes min/med/p90/max', round(min(speed_spike),2), round(sorted(speed_spike)[len(speed_spike)//2],2), round(sorted(speed_spike)[int(len(speed_spike)*0.9)],2), round(max(speed_spike),2))
print(' implied speed med/max m/s', round(sorted([s['implied_mps'] for s in spikes])[len(spikes)//2],1), round(max(s['implied_mps'] for s in spikes),1))
jb=Counter()
for s in spikes:
    if s['dist_m']<80: jb['50-80m']+=1
    elif s['dist_m']<120: jb['80-120m']+=1
    elif s['dist_m']<200: jb['120-200m']+=1
    else: jb['200m+']+=1
print(' jump buckets', dict(jb))
hc=Counter(datetime.fromtimestamp(s['t_ms']/1000,tz=NZ).strftime('%H:%M')[:4]+'x' for s in spikes)
# 10-min bins
hb=Counter(datetime.fromtimestamp(s['t_ms']/1000,tz=NZ).strftime('%H:%M') for s in spikes)
bins=Counter()
for s in spikes:
    t=datetime.fromtimestamp(s['t_ms']/1000,tz=NZ)
    b=f"{t.strftime('%H')}:{(t.minute//10)*10:02d}"
    bins[b]+=1
print(' spikes per 10min bin (nonzero):', {k:v for k,v in sorted(bins.items()) if v})

route23=parse(fetch('2026-07-23T06:00:00+12:00','2026-07-23T12:00:00+12:00'))
for i in range(1,len(route23)):
    dt=(route23[i]['t_ms']-route23[i-1]['t_ms'])/1000
    if dt<=0 or dt>5: continue
    d=haversine_m(route23[i-1]['lat'],route23[i-1]['lon'],route23[i]['lat'],route23[i]['lon'])
    if d>20:
        t=datetime.fromtimestamp(route23[i]['t_ms']/1000,tz=NZ)
        print('Jul23 >20m only:', t.strftime('%F %T'), 'd',round(d,1),'gap',dt,'acc',route23[i-1]['acc'],route23[i]['acc'],'speed',route23[i-1]['speed'],route23[i]['speed'])

# samples with acc>15 on jul24 vs spike overlap
high_acc_idxs=set()
for i,p in enumerate(pts):
    if p['acc'] is not None and float(p['acc'])>=15:
        high_acc_idxs.add(i)
spike_idxs=set(s['i'] for s in spikes)
overlap=len(spike_idxs & high_acc_idxs)
print('Jul24 points acc>=15:', len(high_acc_idxs), 'overlap with spike index', overlap)
