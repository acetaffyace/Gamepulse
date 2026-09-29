/* GamePulse workspace navigation and overview; shared engine and export controls. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = escapeHtml;
  const sourceTime=value=>!value?'—':!value.includes('T')?value:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
  const paths = {
    pulse:'M3 12h4l3-8 4 16 3-8h4',
    grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    compare:'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4',
    video:'M4 5h16v14H4z M10 9l5 3-5 3z',
    users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M15 4a4 4 0 0 1 0 8m7 9v-2a4 4 0 0 0-3-3.9M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    layers:'m12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5',
    settings:'M4 7h16M4 17h16M8 4v6M16 14v6',
    export:'M12 3v12m-4-4 4 4 4-4M5 15v6h14v-6',
    share:'M15 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6M5 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6M8 10l5-3M8 14l7 4',
    table:'M3 4h18v16H3z M3 9h18M9 9v11',
    arrow:'M5 12h14m-5-5 5 5-5 5',
    link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
    home:'m3 10 9-7 9 7v11H3z M9 21v-8h6v8',
  };
  const icon = name => `<svg class="studio-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.grid}"/></svg>`;
  const pages = {
    overview:['运营总览','把版本、玩家与内容表现，放在同一个视野里。','grid'],
    trends:['运营趋势','在同一条时间轴上，观察评测、在线与版本事件。','pulse'],
    versions:['版本对比','按各自更新起点对齐，比较相同阶段的表现。','compare'],
    videos:['视频传播','比较同类官方内容，联动不同平台与频道语区。','video'],
    players:['玩家结构','从评测时长与语言构成，观察评测者的变化。','users'],
    sources:['数据来源','查看采样覆盖、历史回填与指标口径。','layers'],
    explore:['自由探索','组合指标轨道，保存和导出你的分析视图。','settings'],
  };
  const initialPage = new URLSearchParams(location.search).get('page');
  let page = Object.hasOwn(pages, initialPage) ? initialPage : 'overview';
  let overviewChart = null;
  let rankSource = 'bilibili';
  let busy = false;
  copyLink = async function() {
    const url=new URL(location.href);
    url.searchParams.set('page',page);
    url.hash=serializeView();
    try { await navigator.clipboard.writeText(url.href);toast('已复制当前页面与筛选条件'); }
    catch (_) { prompt('复制当前视图链接：',url.href); }
  };
  document.body.dataset.page = page;
  document.body.insertAdjacentHTML('afterbegin', `
    <aside class="studio-sidebar" aria-label="工作台导航"><div class="studio-sidebar-inner">
      <div class="studio-brand"><span class="brand-icon">${icon('pulse')}</span><div>GamePulse<small>游戏长线运营观测</small></div></div>
      <div class="eyebrow">分析页面</div>
      <nav class="studio-nav" aria-label="分析页面">${Object.entries(pages).map(([key,[title,,symbol]]) => `<button data-page-nav="${key}" ${key===page?'aria-current="page"':''}>${icon(symbol)}<span>${title}</span></button>`).join('')}</nav>
      <div class="game-nav" id="studioGameNav" role="group" aria-labelledby="studioGameNavTitle"><div class="eyebrow" id="studioGameNavTitle">关注的游戏</div></div>
      <div class="sidebar-foot"><div class="workspace-person"><span>GP</span><div>公开数据工作台<small>Steam · B 站 · YouTube</small></div></div></div>
    </div></aside>
    <div class="studio-topbar"><div class="studio-breadcrumb">${icon('home')}<span>工作台</span><span>/</span><b id="studioCrumb">${pages[page][0]}</b></div><div class="topbar-right"><span class="topbar-status" id="studioSnapshot">读取数据快照</span><span class="demo-pill">公开数据工作台</span></div></div>`);
  const originalHeader = document.querySelector('.shell>header');
  // 「快照已 N 天未更新」和「有新数据」都要在工作台顶栏可见，不能跟着原页眉一起被隐藏
  document.querySelector('.topbar-right').prepend($('dataStatus'),$('reloadSnapshot'));
  const meta = originalHeader.querySelector('.meta');
  meta.hidden = true;
  originalHeader.querySelector('h1').id = 'studioTitle';
  originalHeader.querySelector('.sub').id = 'studioSubtitle';
  const actions = document.createElement('div');
  actions.className = 'studio-header-actions';
  originalHeader.append(actions);
  // 文字放进 .btn-label：app.js 切换数据表时只改这段文字，不会抹掉图标
  for (const [id,symbol,label] of [['toggleTable','table','显示数据表'],['openPanel','settings','自定义视图']]) {
    $(id).innerHTML = icon(symbol)+`<span class="btn-label">${label}</span>`;
    actions.append($(id));
  }
  const share = document.createElement('button');
  share.id='demoShare';share.className='linkish';share.innerHTML=icon('share')+'分享';
  share.onclick=()=>copyLink();actions.append(share);
  $('openExport').innerHTML=icon('export')+'导出';
  actions.append($('openExport').parentElement);
  const filters = document.querySelector('.filters');
  const box = document.createElement('div');box.className='studio-filter-box';filters.before(box);box.append(filters);
  const advanced = document.createElement('div');advanced.className='studio-advanced';advanced.id='studioAdvanced';advanced.hidden=true;box.append(advanced);
  advanced.append($('alignGroup'), document.querySelector('.custom-range'), $('presetGroup'));
  const filterToggle=document.createElement('button');filterToggle.className='studio-button';filterToggle.id='demoFilters';filterToggle.setAttribute('aria-expanded','false');filterToggle.setAttribute('aria-controls','studioAdvanced');filterToggle.innerHTML=icon('settings')+'更多筛选';
  filterToggle.onclick=()=>{advanced.hidden=!advanced.hidden;filterToggle.setAttribute('aria-expanded',String(!advanced.hidden));};
  filters.append(filterToggle);
  const configure=document.createElement('button');configure.className='studio-button';configure.id='studioConfigure';configure.textContent='指标与视频配置';configure.onclick=()=>$('openPanel').click();advanced.append(configure);
  const tableShortcut=document.createElement('button');tableShortcut.className='studio-button';tableShortcut.textContent='数据表视图';tableShortcut.onclick=()=>$('toggleTable').click();advanced.append(tableShortcut);
  document.querySelector('.filter-actions').hidden=true;
  const details=[...document.querySelectorAll('#app>.dashboard-details')];
  details[0].id='comparisonDetails';details[1].id='sourceDetails';
  for(const [id,parent] of [['cmpTable','windowTableCard'],['cadenceTable','cadenceTableCard'],['versionTable','versionTableCard'],['langTable','langTableCard']]) $(id).closest('.card').id=parent;
  const overview=document.createElement('section');overview.className='studio-overview';overview.setAttribute('aria-label','总览图表');
  overview.innerHTML=`
    <article class="studio-card studio-chart-card"><div class="studio-card-heading"><div><h2>运营趋势</h2><p id="overviewNote">Steam 公开数据 · 随所选对象与时间范围变化</p></div><select id="demoMetric" aria-label="总览趋势指标"><option value="online">Steam 日均同时在线</option><option value="new_reviews">每日评测变化</option><option value="review_rate">累计好评率</option></select></div><div class="studio-legend" id="overviewLegend"></div><div id="overviewChart" role="img" aria-label="所选指标的时间趋势图"></div><button class="studio-text-button" data-page-nav="trends">展开完整时间轴 →</button></article>
    <article class="studio-card studio-events-card"><div class="studio-card-heading"><h2>版本节点</h2><button class="studio-text-button" data-page-nav="versions">对比 →</button></div><p id="eventScope">所选窗口内的版本更新</p><div class="event-list" id="studioEvents"></div><div class="events-foot">节点表示更新日期，不自动推断因果</div></article>
    <article class="studio-card studio-video-card"><div class="studio-card-heading"><div><h2>官方内容表现</h2><p id="rankScope">角色 PV · 当前累计播放 · 按发布日期筛选</p></div><button class="studio-text-button" data-page-nav="videos">视频分析 →</button></div><div class="ranking-tabs" role="group" aria-label="排行来源"><button data-rank-source="bilibili" aria-pressed="true">B 站</button><button data-rank-source="global" aria-pressed="false">YouTube · 全球</button><button data-rank-source="ja" aria-pressed="false">日语</button><button data-rank-source="ko" aria-pressed="false">韩语</button><button data-rank-source="zh-tw" aria-pressed="false">繁中</button></div><div id="studioRanking"></div></article>
    <article class="studio-card"><div class="studio-card-heading"><h2>数据覆盖</h2><button class="studio-text-button" data-page-nav="sources">详情 →</button></div><p id="qualityScope">所选主对象的数据快照</p><div id="studioQuality"></div></article>`;
  document.querySelector('.numeric-summary').after(overview);
  document.querySelector('.shell').insertAdjacentHTML('beforeend','<footer class="studio-footer"><span>GamePulse · 游戏长线运营观测</span><span>Steam / B 站 / YouTube · 公开信号，非全平台 DAU</span></footer>');

  function resizeCharts() {
    requestAnimationFrame(()=>{
      chart?.resize();
      overviewChart?.resize();
      if (typeof videoCharts!=='undefined') videoCharts.forEach(c=>{if(!c.isDisposed())c.resize();});
      window.StudioDetails?.resize();
    });
  }
  function updatePage() {
    document.body.dataset.page=page;
    const url=new URL(location.href);url.searchParams.set('page',page);history.replaceState(null,'',url);
    $('studioTitle').textContent=pages[page][0];$('studioSubtitle').textContent=pages[page][1];$('studioCrumb').textContent=pages[page][0];
    document.querySelectorAll('.studio-nav [data-page-nav]').forEach(b=>{if(b.dataset.pageNav===page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    $('comparisonDetails').open=['versions','players','explore'].includes(page);
    $('sourceDetails').open=page==='sources';
    window.StudioDetails?.syncPage();
    resizeCharts();
  }
  async function navigate(next) {
    if(!config || busy) return;
    const savedVideoViews=videoViews;
    page=next;
    const url=new URL(location.href);url.searchParams.set('page',page);history.replaceState(null,'',url);
    if(page==='versions') {
      // Seed a useful same-game comparison only when the selection is a single whole game.
      if(subjects.length===1 && subjects[0].kind==='game') {
        const game=catalog.find(g=>g.game_id===subjects[0].gameId);
        const recent=(game?.versions||[]).slice(-2);
        if(recent.length===2) {
          subjects=paintSubjects(recent.map(v=>subjectFromKey(catalog,`${game.game_id}@${v.key}`)));
          align='day0';rangeDays=14;await refresh();
          // 替用户换了对比对象和时间窗口，必须说一声
          toast(`已切换为 ${subjects.map(s=>s.label).join(' 与 ')} 的首 14 天对比，按各自更新日对齐。可在上方改选版本或天数。`);
        }
      }
      applyPreset('versions');
    }
    if(page==='players')applyPreset('player_profile');
    if(page==='trends')applyPreset('default');
    if(['versions','players','trends'].includes(page))videoViews=savedVideoViews;
    if(page==='videos'&&!videoViews.length)videoViews=defaultVideoViews();
    updatePage();renderPanel();renderAll();window.scrollTo({top:0,behavior:'instant'});
  }
  document.querySelectorAll('[data-page-nav]').forEach(b=>b.onclick=()=>guarded(()=>navigate(b.dataset.pageNav),'切换页面失败'));
  async function selectGame(gameId) {
    if(!config||busy)return;
    busy=true;
    try {
      subjects=paintSubjects([subjectFromKey(catalog,gameId)]);align='calendar';
      if(page==='versions') {page='overview';updatePage();}
      await refresh();
    }catch(e){toast('读取游戏快照失败：'+e.message);}finally{busy=false;}
  }
  /* 游戏切换按钮从目录生成：新增游戏不需要改这里。字标取简称首字，
     颜色取 index.json 的游戏色，与图上的颜色一致。 */
  function renderGameNav() {
    const nav=$('studioGameNav');
    if(!nav||nav.dataset.ready||!catalog.length)return;
    nav.dataset.ready='1';
    nav.insertAdjacentHTML('beforeend',catalog.map(g=>{
      const name=g.short_name||g.display_name||g.game_id;
      return `<button data-game="${esc(g.game_id)}" aria-pressed="false" style="--game:${esc(g.color||'#6a4fc4')}"><span class="game-monogram">${esc(Array.from(name)[0]||'?')}</span><span class="game-name">${esc(name)}</span></button>`;
    }).join(''));
    nav.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>selectGame(b.dataset.game));
  }
  document.querySelectorAll('[data-rank-source]').forEach(b=>b.onclick=()=>{
    rankSource=b.dataset.rankSource;
    document.querySelectorAll('[data-rank-source]').forEach(t=>t.setAttribute('aria-pressed',String(t===b)));
    renderRanking();
  });
  $('demoMetric').onchange=()=>renderOverviewChart();

  function renderOverviewChart() {
    if(!subjects.length){overviewChart?.clear();$('overviewLegend').textContent='请选择游戏或版本';return;}
    if(!overviewChart)overviewChart=echarts.init($('overviewChart'));
    const ctx=buildCtx();
    const metric=$('demoMetric').value;
    const lane={...config.lanes.find(l=>l.id===metric)};
    if(metric==='review_rate')lane.series=lane.series.filter(s=>s.field==='display_cumulative_review_rate');
    // 多个对象时只画日均；单个对象时附带官方定时采样虚线，补上 SteamDB 导入日之后的几天
    if(metric==='online'&&subjects.length>1)lane.series=lane.series.filter(s=>s.field==='value');
    const result=ADAPTERS.series(lane,ctx);
    const visible=result.series.filter(s=>!hiddenSubjects.has(s.subject.key));
    // 颜色跟随对象：游戏用 index.json 的游戏色，版本用固定的版本色
    const colors=visible.map(s=>s.subject.color);
    $('overviewLegend').innerHTML=visible.map((s,i)=>`<span style="--mark:${esc(colors[i])}">${esc(s.name)}</span>`).join('');
    $('overviewNote').textContent=metric==='online'?'实线：SteamDB 全天平均 · 虚线：Steam 官方每日定时采样 · 非 DAU':metric==='new_reviews'?'评测数（按发布日回填）/ Steam 净变化 · 缺采保留为空':'游戏全局累计好评率 · 回填接续 Steam 观测';
    const versionMarks=ctx.multi?[]:(subjects[0].snap.events||[]).filter(e=>e.is_version_boundary).map(e=>({name:`${e.version_id} 更新`,xAxis:axisKeyOf(e.date_local,subjects[0],align)})).filter(e=>ctx.axis.keys.includes(e.xAxis));
    overviewChart.setOption({animation:false,textStyle:{fontFamily:FONT},aria:{enabled:true,label:{description:`${$('demoMetric').selectedOptions[0].textContent}趋势：${visible.map(s=>s.name).join('、')}`}},tooltip:{trigger:'axis',confine:true,backgroundColor:'#fff',borderColor:'#e9e6f0',textStyle:{color:'#515b70',fontSize:11}},grid:{left:8,right:14,top:29,bottom:9,containLabel:true},
      xAxis:{type:'category',data:ctx.axis.keys,boundaryGap:metric==='new_reviews',axisLine:{show:false},axisTick:{show:false},axisLabel:{color:'#5f6779',fontSize:10,formatter:k=>axisLabelOf(k,align),hideOverlap:true}},
      yAxis:{type:'value',scale:metric==='review_rate',splitNumber:4,axisLabel:{color:'#5f6779',fontSize:10,formatter:v=>metric==='review_rate'?v+'%':Math.abs(v)>=10000?(v/10000).toFixed(1)+'万':v},splitLine:{lineStyle:{color:'#f0f1f7',type:'dashed'}}},
      series:visible.map((s,i)=>({name:s.name,type:metric==='new_reviews'?'bar':'line',data:s.values,symbol:'circle',symbolSize:4,showSymbol:s.values.filter(v=>v!=null).length<18,connectNulls:false,smooth:false,barMaxWidth:13,itemStyle:{color:colors[i%colors.length],borderRadius:[3,3,0,0]},lineStyle:{width:2.3,type:s.dashed?'dashed':'solid'},areaStyle:metric==='online'&&visible.length===1?{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:colors[i]+'38'},{offset:1,color:colors[i]+'03'}])}:undefined,
      markLine:i===0&&versionMarks.length?{symbol:'none',silent:true,lineStyle:{color:'#dcd6eb',type:'dashed'},label:{formatter:'{b}',position:'insideEndTop',fontSize:9,color:'#5f6779'},data:versionMarks}:undefined}))},true);
    overviewChart.resize();
  }
  /* 官方内容排行。默认看所选窗口内发布的角色 PV；窗口里没有时依次放宽
     到「全部重点类型」「全部登记期」，并在副标题里写明放宽了什么 ——
     面试官切到任何一个游戏、任何一个窗口都不会看到空白卡片。 */
  function rankingRows(s,types,whole){
    const view={mode:'snapshot',metric:'view',scale:'abs',platforms:[rankSource==='bilibili'?'bilibili':'youtube'],locales:rankSource==='bilibili'?[]:[rankSource],content_types:types};
    const base={...buildCtx(),subjects:[s],multi:false};
    const ctx=whole?{...base,axis:{keys:dateRange(s.window.start,s.window.end||s.snap.snapshot_date),align:'calendar'}}:base;
    return VideoModel.prepare(selectedVideoRecords(view,ctx),view).map(r=>{
      const point=r.points.at(-1);
      return {name:r.name,value:point?.value,date:point?.date,pubdate:r.video.pubdate};
    }).filter(v=>v.value!=null).sort((a,b)=>b.value-a.value).slice(0,4);
  }
  function renderRanking() {
    const s=subjects[0];
    if(!s){$('studioRanking').innerHTML='<div class="demo-empty">请选择一个游戏</div>';return;}
    const aw=analysisWindow(s);
    const all=[...(config.important_video_types||['character_trailer'])];
    const attempts=[
      [['character_trailer'],false,`角色 PV · ${aw.start.slice(5)}—${aw.end.slice(5)} 发布`],
      [all,false,`所选窗口内无角色 PV · 改看全部重点类型 · ${aw.start.slice(5)}—${aw.end.slice(5)} 发布`],
      [['character_trailer'],true,'所选窗口内无新发布 · 改看全部登记的角色 PV'],
      [all,true,'所选窗口内无新发布 · 改看全部登记的重点视频'],
    ];
    let rows=[],scope=attempts[0][2];
    for(const [types,whole,label] of attempts){rows=rankingRows(s,types,whole);scope=label;if(rows.length)break;}
    $('rankScope').textContent=`${s.label} · 当前累计播放 · ${scope}`;
    const source=document.querySelector(`[data-rank-source="${rankSource}"]`)?.textContent||'';
    $('studioRanking').innerHTML=rows.length?rows.map((r,i)=>`<div class="rank-row" title="${esc(r.name)} · 发布 ${esc(r.pubdate)} · 采样 ${esc(r.date)} · ${r.value.toLocaleString('zh-CN')} 次"><span class="rank-number">0${i+1}</span><span class="rank-name">${esc(r.name)}</span><div class="rank-track"><div class="rank-fill" style="width:${rows[0].value>0?r.value/rows[0].value*100:0}%;opacity:${1-i*.12}"></div></div><span class="rank-value">${r.value>=10000?(r.value/10000).toFixed(1)+' 万':r.value.toLocaleString('zh-CN')}</span></div>`).join(''):`<div class="demo-empty">${esc(source)}暂无登记的官方视频，可切换其他来源</div>`;
  }
  function renderContext() {
    const s=subjects[0];
    renderGameNav();
    document.querySelectorAll('[data-game]').forEach(b=>b.setAttribute('aria-pressed',String(subjects.some(s=>s.gameId===b.dataset.game))));
    document.querySelectorAll('#alignSeg button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.align===align)));
    if(!s){$('studioEvents').innerHTML='<div class="demo-empty">请选择游戏或版本</div>';$('studioQuality').innerHTML='';$('studioHealthPanel')?.remove();$('studioSnapshot').textContent='请选择游戏或版本';return;}
    const aw=analysisWindow(s);
    const events=(s.snap.events||[]).filter(e=>e.is_version_boundary&&e.date_local>=aw.start&&e.date_local<=aw.end).slice(-3).reverse();
    // 窗口里没有版本更新时（例如只看最近 3 天）改列最近的版本节点，并在标题里写明
    const inWindow=events.length>0;
    const shown=inWindow?events:(s.snap.events||[]).filter(e=>e.is_version_boundary&&e.date_local<=aw.end).slice(-3).reverse();
    $('eventScope').textContent=inWindow?`${s.label} · 所选窗口内的版本更新`:`${s.label} · 所选窗口内无版本更新，列出此前最近的节点`;
    const dot=e=>{const v=(catalog.find(g=>g.game_id===s.gameId)?.versions||[]).find(v=>v.date_local===e.date_local);return v?`style="background:${esc(versionColor(catalog,s.gameId,v.key))}"`:'';};
    $('studioEvents').innerHTML=shown.length?shown.map((e,i)=>`<div class="event-row"><span class="event-dot" ${dot(e)}></span><div><strong>${esc(s.snap.game.short_name)} ${esc(e.version_id)} 版本更新</strong><small>${esc(e.date_local)} · Steam 官方公告</small><span class="event-tag">${i===0?(inWindow?'窗口内最近更新':'最近一次更新'):'历史版本'}</span></div></div>`).join(''):'<div class="demo-empty">暂无版本更新记录</div>';
    const snap=s.snap,coverage=snap.coverage||{};
    const missing=new Set((snap.quality?.issues||[]).filter(q=>q.code==='missing_days').flatMap(q=>q.missing_days||[]));
    const dates=coverage.start&&coverage.end?dateRange(coverage.start,coverage.end).slice(-20):[];
    $('qualityScope').textContent=`${s.label} · 快照 ${snap.snapshot_date}`;
    $('studioQuality').innerHTML=`<div class="quality-source"><span>逐日采样覆盖</span><b class="${coverage.missing_days?'warn':'ok'}">${coverage.valid_days??'—'} / ${coverage.expected_days??'—'} 天</b></div><div class="quality-source"><span>评测历史</span><b class="ok">${snap.review_history_coverage?.days??'—'} 天 · 回填</b></div><div class="quality-source"><span>快照质量记录</span><b class="warn">${snap.quality?.summary?.warn??0} 项提示</b></div><div class="quality-dots">${dates.map(d=>`<i class="${missing.has(d)?'missing':''}" title="${d} · ${missing.has(d)?'缺采':'有采样记录'}"></i>`).join('')}</div><div class="quality-note">最近采样覆盖 · 浅黄表示整日缺采<br>单项指标仍可能缺失，详见数据来源。</div>`;
    $('studioSnapshot').textContent=`数据快照 · ${snap.snapshot_date}`;
    const sourceLabels={steam:'Steam 日采',bilibili:'B 站视频',youtube:'YouTube 视频',steam_online:'小时在线',steam_build:'构建记录',review_profile:'评测画像基底'};
    const statusLabels={healthy:'有有效观测',partial:'部分失败',failed:'最近采集失败',stale:'数据待更新',skipped:'未采集 / 已跳过',disabled:'未启用'};
    const sourceName=k=>sourceLabels[k]||esc(k);const statusName=v=>statusLabels[v]||'状态未知';
    const now=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const health=Object.entries(snap.source_health||{}).map(([key,v])=>{
      const stale=v.data_through&&daysBetween(v.data_through.slice(0,10),now)>=(v.schedule==='weekly'?8:2);
      return [key,{...v,status:v.status==='healthy'&&stale?'stale':v.status}];
    });
    const concerns=health.filter(([,v])=>!['healthy','skipped','disabled'].includes(v.status));
    $('studioSnapshot').dataset.health=concerns.length?'degraded':'healthy';
    $('studioSnapshot').textContent=`快照 ${snap.snapshot_date}${concerns.length?' · '+concerns.length+' 项来源需关注':''}`;
    if(health.length){
      $('studioQuality').innerHTML=health.filter(([k])=>['steam','bilibili','youtube','review_profile'].includes(k)).map(([k,v])=>`<div class="quality-source"><span>${sourceName(k)}</span><b class="${v.status==='healthy'?'ok':'warn'}">${statusName(v.status)}${v.status!=='healthy'&&v.data_through?` · 有效数据至 ${esc(v.data_through.slice(5,10))}`:''}</b></div>`).join('')+`<div class="quality-note">有效数据与最近采集状态分别记录。<br>失败时仍可查看保留的历史观测。</div>`;
      let panel=$('studioHealthPanel');
      if(!panel){panel=document.createElement('section');panel.id='studioHealthPanel';panel.className='card';$('sourceDetails').querySelector('summary').after(panel);}
      panel.innerHTML=`<div class="card-head"><h2 class="card-title">数据源运行状态</h2><span class="card-note">${esc(s.label)} · UTC+8</span></div><div class="table-wrap"><table><thead><tr><th>来源</th><th>最近尝试</th><th>有效数据截至</th><th>最近成功 / 期望数</th><th>状态</th></tr></thead><tbody>${health.map(([k,v])=>`<tr><td>${sourceName(k)}</td><td>${esc(sourceTime(v.last_attempt_at))}</td><td>${esc(v.data_through||'暂无')}</td><td>${v.expected!=null?`${v.succeeded} / ${v.expected}`:v.succeeded!=null?`${v.succeeded} 条评测`:'—'}</td><td><span class="health-status ${v.status==='healthy'?'healthy':'attention'}">${statusName(v.status)}</span></td></tr>`).join('')}</tbody></table></div><p class="card-note">采集失败不等于历史值无效；图表保留最后有效值，缺采不补零。评测画像按周更新。</p>`;
    }
  }
  const productionRender=renderAll;
  renderAll=function(){
    productionRender();
    renderContext();renderRanking();
    window.StudioDetails?.render();
    if(page==='overview')renderOverviewChart();
    resizeCharts();
  };
  const observer=new MutationObserver(()=>{
    if(!$('app').classList.contains('hidden')){
      if(page==='overview')renderOverviewChart();
      resizeCharts();observer.disconnect();
      window.StudioDetails?.ready();
    }
  });
  observer.observe($('app'),{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',resizeCharts);
  updatePage();
})();
