/* Detailed Studio views reuse the same prepared observations and comparison windows. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const e=videoEscape;
  const requestedComparison=location.search.includes('page=versions') && !location.hash;
  let presentation=new URLSearchParams(location.search).get('videoDisplay')==='timeline'?'timeline':'rank';
  let compareMetric='new_reviews';
  let compareChart=null;
  let changing=false;
  const timeline=document.createElement('details');
  timeline.id='studioFullTimeline';timeline.open=true;
  timeline.innerHTML='<summary>完整指标时间轴 <span>展开查看全部轨道与口径</span></summary>';
  $('timelineCard').before(timeline);timeline.append($('timelineCard'));
  timeline.addEventListener('toggle',()=>{if(timeline.open)requestAnimationFrame(()=>chart?.resize());});
  const comparison=document.createElement('section');comparison.id='studioComparison';
  comparison.innerHTML=`
    <div class="compare-pickers studio-card"><div class="compare-picker"><span class="compare-letter">A</span><label for="compareA">基准版本<select id="compareA"></select></label></div><button class="studio-button compare-swap" id="compareSwap" aria-label="交换对比对象">⇄</button><div class="compare-picker"><span class="compare-letter b">B</span><label for="compareB">对比版本<select id="compareB"></select></label></div><div class="compare-alignment"><span id="compareWindow"></span><button id="compareAlign" class="studio-text-button">按更新起点对齐 →</button></div></div>
    <div id="compareMetrics" class="compare-metrics"></div>
    <div class="studio-card compare-chart-card"><div class="studio-card-heading"><div><h2>同阶段表现</h2><p id="compareChartNote"></p></div><div class="segmented" role="group" aria-label="版本对比指标"><button data-compare-metric="new_reviews" aria-pressed="true">评测量</button><button data-compare-metric="review_rate" aria-pressed="false">好评率</button><button data-compare-metric="online" aria-pressed="false">同时在线</button></div></div><div class="compare-chart-legend" id="compareLegend"></div><div id="compareChart" role="img" aria-label="两个版本同阶段表现对比图"></div><div class="compare-chart-foot"><span id="compareEvidence"></span><button id="compareChartPng" class="studio-text-button">导出此图 PNG ↓</button></div></div>`;
  timeline.before(comparison);
  function pageIsComparison(){return document.body.dataset.page==='versions';}
  function syncPage(){
    timeline.open=!pageIsComparison();
    if(pageIsComparison())$('comparisonDetails').open=false;
  }
  async function setPair(a,b){
    if(changing || !a || !b)return;
    if(a===b){toast('请选择两个不同的对比对象');renderComparison();return;}
    changing=true;
    try {
      subjects=paintSubjects([a,b].map(k=>subjectFromKey(catalog,k)).filter(Boolean));
      await refresh();renderPanel();
    }catch(error){toast('对比数据加载失败：'+error.message);}finally{changing=false;}
  }
  $('compareA').onchange=()=>setPair($('compareA').value,$('compareB').value);
  $('compareB').onchange=()=>setPair($('compareA').value,$('compareB').value);
  $('compareSwap').onclick=()=>setPair($('compareB').value,$('compareA').value);
  $('compareAlign').onclick=()=>{align='day0';renderAll();};
  document.querySelectorAll('[data-compare-metric]').forEach(btn=>btn.onclick=()=>{
    compareMetric=btn.dataset.compareMetric;
    document.querySelectorAll('[data-compare-metric]').forEach(b=>b.setAttribute('aria-pressed',String(b===btn)));
    renderComparisonChart();
  });
  $('compareChartPng').onclick=async()=>{
    if(!compareChart)return;
    const picture=new Image();
    picture.src=compareChart.getDataURL({type:'png',pixelRatio:2,backgroundColor:'#fff'});
    await picture.decode();
    const canvas=document.createElement('canvas');canvas.width=picture.width;canvas.height=picture.height+180;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#303a50';ctx.font='bold 26px sans-serif';ctx.fillText('GamePulse · 版本对比',30,42);
    ctx.font='21px sans-serif';
    ctx.fillText(subjects.slice(0,2).map((s,i)=>`${i?'B':'A'}：${s.label}`).join('     /     '),30,82);
    ctx.font='17px sans-serif';ctx.fillStyle='#737f94';
    ctx.fillText(`窗口：${$('compareWindow').textContent} · 快照：${subjects[0]?.snap.snapshot_date||'—'} · UTC+8`,30,120);
    ctx.fillText('A 紫色 / B 绿色 · '+$('compareChartNote').textContent,30,152);
    ctx.drawImage(picture,0,180);
    const link=document.createElement('a');link.href=canvas.toDataURL('image/png');link.download=`gamepulse_compare_${compareMetric}.png`;link.click();
  };
  function signed(n,digits=1){return (n>0?'+':'')+n.toFixed(digits);}
  function format(n,digits=0){return n==null?'—':n.toLocaleString('zh-CN',{maximumFractionDigits:digits,minimumFractionDigits:digits});}
  function renderComparison(){
    if(!config||!subjects.every(s=>s.snap))return;
    const options=catalog.map(g=>`<optgroup label="${e(g.short_name)}"><option value="${e(g.game_id)}">${e(g.short_name)} · 整段</option>${g.versions.slice().reverse().map(v=>`<option value="${e(g.game_id+'@'+v.key)}">${e(g.short_name)} ${e(v.version_id)} · ${v.date_local}</option>`).join('')}</optgroup>`).join('');
    $('compareA').innerHTML='<option value="">选择基准对象</option>'+options;
    $('compareB').innerHTML='<option value="">选择对比对象</option>'+options;
    $('compareA').value=subjects[0]?.key||'';$('compareB').value=subjects[1]?.key||'';
    const pair=subjects.slice(0,2);
    const ctx=buildCtx();
    $('compareWindow').textContent=align==='day0'?`D0—D${Math.max(0,ctx.axis.keys.length-1)} · 共同时间窗口`:'日历日期 · 按实际日期对齐';
    $('compareAlign').hidden=align==='day0';
    if(pair.length!==2){$('compareMetrics').innerHTML='<div class="compare-empty">选择两个版本，查看相同阶段的变化。</div>';compareChart?.clear();$('compareChartNote').textContent='等待选择两个对象';$('compareLegend').textContent='';$('compareEvidence').textContent='';return;}
    const stats=pair.map(windowStats);
    const sameBasis=stats[0].dailyAvgBasis===stats[1].dailyAvgBasis;
    const rows=[
      {title:'窗口评测量',unit:'条',values:stats.map(w=>w.dailyAvgBasis==='surviving_review_backfill'?w.historicalReviews:w.reviews),digits:0,valid:sameBasis,note:sameBasis?(stats[0].dailyAvgBasis==='surviving_review_backfill'?'历史回填存活评测':'Steam 评测净变化'):'统计口径不同，暂不计算差值'},
      {title:'窗口日均评测',unit:'条 / 日',values:stats.map(w=>w.dailyAvg),digits:1,valid:sameBasis,note:'窗口评测量 ÷ 有效覆盖天数'},
      {title:pair.every(s=>s.kind==='version')?'版本回填好评率':'累计好评率',unit:'%',values:stats.map(w=>w.rate),digits:2,valid:pair[0].kind===pair[1].kind,percent:true,note:pair.every(s=>s.kind==='version')?'窗口内回填好评数 ÷ 回填评测数':'混合对象口径不同，差值仅同类展示'},
      {title:'窗口末同时在线',unit:'人',values:stats.map(w=>w.onlinePoints?w.online:null),digits:0,valid:false,note:`日点：A ${stats[0].onlineDate||'暂无'} / B ${stats[1].onlineDate||'暂无'} · 非 DAU`},
    ];
    $('compareMetrics').innerHTML=rows.map(row=>{
      const [a,b]=row.values;
      const difference=row.valid&&a!=null&&b!=null?(row.percent?signed(b-a,2)+' pp':a!==0?signed((b-a)/Math.abs(a)*100)+'%':'基准为 0'):null;
      return `<article class="compare-metric"><div class="compare-metric-head"><h3>${row.title}</h3>${difference?`<span class="compare-change">${difference}</span>`:''}</div><div class="compare-value"><span class="compare-letter">A</span><strong>${format(a,row.digits)}</strong><small>${row.unit}</small></div><div class="compare-value"><span class="compare-letter b">B</span><strong>${format(b,row.digits)}</strong><small>${row.unit}</small></div><p>${row.note}</p></article>`;
    }).join('');
    $('compareEvidence').textContent=`${pair.map((s,i)=>`${s.label}：${stats[i].window.start}—${stats[i].window.end} · ${stats[i].historicalDays||stats[i].days} 天评测覆盖`).join(' ｜ ')}${subjects.length>2?' · 本区展示前两个对象，其余对象见完整时间轴':''}`;
    if(pageIsComparison())renderComparisonChart();
  }
  function renderComparisonChart(){
    const pair=subjects.slice(0,2);if(pair.length!==2||!pair.every(s=>s.snap))return;
    if(!compareChart)compareChart=echarts.init($('compareChart'));
    const globalCtx=buildCtx();const ctx={...globalCtx,subjects:pair,multi:true};
    const lane={...config.lanes.find(l=>l.id===compareMetric)};
    let series=ADAPTERS.series(lane,ctx).series;
    if(compareMetric==='review_rate'&&pair.every(s=>s.kind==='version'))series=series.filter(s=>s.dashed);
    const colors=['#8262cc','#42a58d'];
    const label=compareMetric==='new_reviews'?'每日评测变化':compareMetric==='online'?'Steam 同时在线':'版本窗口滚动累计好评率';
    $('compareChartNote').textContent=compareMetric==='review_rate'?(pair.every(s=>s.kind==='version')?'各版本从更新日重新累计 · 缺采保留为空':'游戏全局累计好评率 · 历史回填接续观测'):compareMetric==='new_reviews'?'每日存活评测回填 / Steam 净变化 · 颜色代表对比对象':'Steam / SteamDB 日点 · 同一阶段不代表同一采样时刻';
    $('compareLegend').innerHTML=pair.map((s,i)=>`<span><i style="background:${colors[i]}"></i>${i?'B':'A'} · ${e(s.label)}</span>`).join('');
    compareChart.setOption({animation:false,textStyle:{fontFamily:FONT},title:{text:label,left:8,top:0,textStyle:{fontSize:11,fontWeight:400,color:'#717b8e'}},tooltip:{trigger:'axis',confine:true},grid:{left:12,right:22,top:36,bottom:20,containLabel:true},
      xAxis:{type:'category',data:ctx.axis.keys,boundaryGap:compareMetric==='new_reviews',axisLine:{show:false},axisTick:{show:false},axisLabel:{fontSize:11,color:'#858da0',formatter:k=>align==='day0'?'D'+k:k.slice(5),hideOverlap:true}},
      yAxis:{type:'value',scale:compareMetric==='review_rate',splitLine:{lineStyle:{color:'#eceef5',type:'dashed'}},axisLabel:{fontSize:11,color:'#858da0',formatter:v=>compareMetric==='review_rate'?v+'%':v>=10000?(v/10000).toFixed(1)+'万':v}},
      series:series.map(s=>({name:s.subject.label,type:compareMetric==='new_reviews'?'bar':'line',data:s.values,barMaxWidth:18,barGap:'30%',showSymbol:true,symbolSize:5,connectNulls:false,itemStyle:{color:colors[pair.findIndex(p=>p.key===s.subject.key)],borderRadius:[3,3,0,0]},lineStyle:{width:2.5}}))},true);compareChart.resize();
  }
  function enhanceVideos(){
    document.querySelectorAll('.video-dashboard').forEach(section=>{
      const view=videoViews.find(v=>v.id===section.dataset.viewId);if(!view)return;
      if(view.mode!=='snapshot')return;
      const toggle=document.createElement('div');toggle.className='studio-video-presentation';
      toggle.innerHTML=`<div class="segmented" role="group" aria-label="累计表现图形"><button data-video-presentation="rank" aria-pressed="${presentation==='rank'}">横向排行</button><button data-video-presentation="timeline" aria-pressed="${presentation==='timeline'}">按发布时间</button></div><span>累计值受视频年龄影响 · 悬停查看采样日期</span>`;
      section.querySelector('.video-content-picks').after(toggle);
      toggle.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{
        presentation=btn.dataset.videoPresentation;
        const url=new URL(location.href);url.searchParams.set('videoDisplay',presentation);history.replaceState(null,'',url);renderAll();
      });
      if(presentation!=='rank')return;
      section.dataset.snapshotPresentation='rank';
      section.classList.add('studio-video-ranking');
      section.querySelector('.video-scale').lastChild.textContent='统一刻度';
      const status=section.querySelector('.video-focus .video-status-inline');if(status)status.textContent='按当前累计值排列 · 点击横条联动同内容';
      section.querySelectorAll('.video-facet').forEach(card=>{
        const el=card.querySelector('.video-chart');const chart=echarts.getInstanceByDom(el);if(!chart)return;
        const old=chart.getOption();
        const data=old.series.flatMap(s=>s.data.map(d=>({...d,barValue:d.point.value,color:s.itemStyle.color,opacity:s.itemStyle.opacity}))).sort((a,b)=>b.barValue-a.barValue);
        const percent=VideoModel.METRICS[view.metric].unit==='%';const indexed=view.metric==='view'&&view.scale==='index';
        const number=v=>indexed?v.toFixed(2)+'×':percent?v.toFixed(2)+'%':v>=10000?(v/10000).toFixed(1)+'万':format(v);
        const label=d=>(subjects.length>1?d.record.subjectLabel+' · ':'')+d.record.name+(view.layout==='overlay'?' · '+VIDEO_SOURCE_LABELS[d.record.source]:'');
        const rows=data.map(d=>label(d));
        const longest=Math.max(1,...rows.map(s=>s.length));const labelWidth=view.layout==='overlay'?Math.min(230,longest*11):Math.min(140,longest*11);
        el.style.height=Math.max(190,data.length*40+35)+'px';
        chart.setOption({animation:false,textStyle:{fontFamily:FONT},aria:{enabled:true,description:'当前累计表现横向排行；点击条形联动内容，采样日期和视频年龄见提示框。'},
          grid:{left:labelWidth+12,right:75,top:6,bottom:25},
          xAxis:{type:'value',min:0,max:view.sharedY||view.layout==='overlay'?old.yAxis[0].max:undefined,axisLine:{show:false},axisTick:{show:false},axisLabel:{fontSize:10,color:'#8e96a7',formatter:number},splitLine:{show:true,lineStyle:{color:'#f1f2f7',type:'dashed'}}},
          yAxis:{type:'category',inverse:true,data:rows,axisLine:{show:false},axisTick:{show:false},axisLabel:{fontSize:11,color:'#5e687a',width:labelWidth,overflow:'truncate',margin:12}},
          tooltip:{...old.tooltip[0],trigger:'item'},
          series:[{name:VideoModel.METRICS[view.metric].label,type:'bar',barMaxWidth:14,showBackground:true,backgroundStyle:{color:'#f6f4fb',borderRadius:4},data:data.map(d=>({...d,value:d.barValue,itemStyle:{color:d.color,opacity:d.opacity,borderRadius:[0,4,4,0]}})),label:{show:true,position:'right',distance:8,color:'#596476',fontSize:11,formatter:p=>number(p.value)}}]},true);
        chart.resize();
        if(!view.focusPair&&data.length){
          const lead=data[0];card.querySelector('.video-selected').innerHTML=`<strong>${number(lead.barValue)}</strong><span>最高 · ${e(lead.record.name)}<br>采于 ${lead.point.date} · 发布 ${lead.point.age} 天</span>`;
        }
      });
    });
  }
  window.StudioDetails={
    render(){enhanceVideos();renderComparison();},
    resize(){compareChart?.resize();},
    syncPage,
    async ready(){
      if(requestedComparison&&subjects.length===1&&subjects[0].kind==='game'){
        const g=catalog.find(g=>g.game_id===subjects[0].gameId);const versions=g?.versions.slice(-2)||[];
        if(versions.length===2){
          align='day0';rangeDays=14;
          const savedVideoViews=videoViews;applyPreset('versions');videoViews=savedVideoViews;
          await setPair(...versions.map(v=>g.game_id+'@'+v.key));
        }
      }
      renderComparison();syncPage();
    },
  };
  syncPage();
})();
