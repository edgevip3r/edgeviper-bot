jQuery(function($){
  // 1) Grab the data once
  let masterData = [];
  $.getJSON(EV_ResultsData.endpoint, d=>{
	masterData = (d.data || []).filter(r =>
		r.date && String(r.date).trim() !== ''
	);
    initTable();
  }).fail(()=>alert('Failed to load bets.'));

  let dt, backtestChart;

  function initTable(){
    // 2) Create empty DataTable
    dt = $('#ev-results-table').DataTable({
      data: [], 
      columns: [
		{
		  data: 'bet_id', title:'ID', type:'num',
		  render: function(d, t){
			if(t==='sort' || t==='type'){
			  // strip commas and parse integer
			  return parseInt(String(d).replace(/,/g,''), 10) || 0;
			}
			return d;
		  }
		},
        { data: 'date',      title:'Date' },
        { data: 'bookie',    title:'Bookie' },
        { data: 'event',     title:'Event' },
        { data: 'bet',       title:'Bet' },
        { data: 'odds',      title:'Odds',    render:d=>d.toFixed(2) },
        { data: 'stake',     title:'Stake',   render:(d,t)=>t==='display'? '£'+d.toFixed(2):d },
        { data: 'result',    title:'W/L' },
        { data: 'profit',    title:'P/L',     render:(d,t)=>t==='display'? '£'+d.toFixed(2):d },
        { data: 'settle_date',title:'Settle Date' }
      ],
      order: [[0,'desc']],
      responsive:true,
      pageLength:25,
      searching:true
    });

    // 3) Setup Chart.js for backtest
    const ctx = document.getElementById('pnl-chart').getContext('2d');
    backtestChart = new Chart(ctx, {
      type:'line',
      data:{ labels:[], datasets:[{ label:'Cumulative P/L', data:[], fill:false, tension:0.4, pointRadius:0 }] },
      options:{
        responsive:true, maintainAspectRatio:false,
        scales:{ x:{display:false}, y:{ticks:{callback:v=>'£'+v}} },
        interaction:{mode:'index',intersect:false},
        plugins:{ legend:{display:false}, tooltip:{callbacks:{
          title: pts=>`Bet #${pts[0].label}`,
          label: ctx=>`P/L: £${ctx.formattedValue}`
        }}}
      }
    });

    // 4) Bind events
    $('#backtest-form').on('change input', 'input,select', rebuildTable);
    dt.on('draw', updateStatsAndChart);

    // 5) First build
    rebuildTable();
  }

  // read current form values
  function getForm(){
    const $f = $('#backtest-form');
    const mode = $f.find('[name=mode]:checked').val();
    return {
      mode,
      bank:  parseFloat($f.find(`[name=bankroll_${mode}]`).val())||0,
      pct:   (parseFloat($f.find('[name=kelly]').val())||0)/100,
      flat:  parseFloat($f.find('[name=flat]').val())||0,
      stw:   parseFloat($f.find('[name=stw]').val())||0,
    };
  }

  // compute stake + profit for one row
  function computeRow(r, cfg){
    let stake=0, profit=0;
    if(cfg.mode==='flat'){
      stake = cfg.flat;
    } else if(cfg.mode==='kelly'){
      const p = r.probability >1 ? r.probability/100 : r.probability;
      stake = Math.floor(((r.odds*p -1)/(r.odds-1)) * cfg.bank * cfg.pct);
    } else { // stw
      stake = Math.ceil(cfg.stw/(r.odds-1));
    }
    if(r.result==='W') profit = stake*(r.odds-1);
    if(r.result==='L') profit = -stake;
    return { ...r, stake, profit };
  }

  // rebuild entire table dataset
  function rebuildTable(){
    const cfg = getForm();
    // toggle form fields
    $('#kelly-group').toggle(cfg.mode==='kelly');
    $('#flat-group').toggle(cfg.mode==='flat');
    $('#stw-group').toggle(cfg.mode==='stw');

    const computed = masterData.map(r=> computeRow(r,cfg) );
    dt.clear().rows.add(computed).draw(false);
  }

  // update KPIs + chart after each draw
function updateStatsAndChart(){
  const cfg = getForm();
  // 1) grab only visible rows
  const raw = dt.rows({ search:'applied' }).data().toArray();

  // 2) sort ascending by numeric Bet ID
  raw.sort((a,b)=>{
    const ia = parseInt(String(a.bet_id).replace(/,/g,''),10)||0;
    const ib = parseInt(String(b.bet_id).replace(/,/g,''),10)||0;
    return ia - ib;
  });

  // 3) accumulate for KPIs & chart
  let totalSt = 0, totalPr = 0, cum = cfg.bank;
  const labels = [], pts = [];

  raw.forEach(r=>{
    // compute stake & profit exactly as in your rebuildTable()
    const computed = computeRow(r, cfg);
    if (['W','L'].includes(computed.result)) {
      totalSt += computed.stake;
      totalPr += computed.profit;
      cum     += computed.profit;
      labels.push(computed.bet_id);
      pts.push(cum.toFixed(2));
    }
  });

  // 4) redraw KPIs
  const roi = totalSt>0 
    ? ((totalPr/totalSt)*100).toFixed(2)+'%' 
    : '0%';
  $('#backtest-stats').html(
    `ROI: <strong>${roi}</strong> | `+
    `Staked: <strong>£${totalSt.toFixed(2)}</strong> | `+
    `Profit: <strong>£${totalPr.toFixed(2)}</strong>`
  );

  // 5) redraw chart (in chronological order)
  backtestChart.data.labels      = labels;
  backtestChart.data.datasets[0].data = pts;
  backtestChart.update();
}
});