jQuery(function($) {
  const url = EV_BetsData.restUrl + '?_=' + Date.now();

  $.ajax({
    url: url,
    method: 'GET',
    dataType: 'json',
	cache: false,
    beforeSend(xhr) { xhr.setRequestHeader('X-WP-Nonce', EV_BetsData.nonce); }
  }).done(function(data) {
    let bets = data.bets || [];

    // Sort by bet_id descending, stripping commas
    bets.sort((a, b) => {
      const idA = parseInt(a.bet_id.replace(/,/g, ''), 10) || 0;
      const idB = parseInt(b.bet_id.replace(/,/g, ''), 10) || 0;
      return idB - idA;
    });

    if (!bets.length) {
      $('#ev-bets-table').replaceWith('<p>No bets placed yet!</p>');
      return;
    }

    // Render KPIs & chart wrapper
    const wrapper = $('<div class="ev-stats-wrapper" ' +
      'style="display:flex;align-items:stretch;gap:1rem;margin-bottom:1rem;"/>');
    $('#ev-bets-table').before(wrapper);

    // Recalculate ROI excluding pending
    const totalStakedSettled = bets
      .filter(b => b.profit != null)
      .reduce((sum, b) => sum + (parseFloat(b.stake) || 0), 0);
    data.stats.roi = totalStakedSettled > 0
      ? ((data.stats.total_profit / totalStakedSettled) * 100).toFixed(2)
      : '0.00';

    renderStats(data.stats, wrapper);
    renderChart(bets, wrapper);

    // Prepare rows for DataTable
    const rows = bets.map(b => {
      // Prefer odds_override when present & numeric, otherwise fall back to odds
      let displayOdds = '-';
      if (b.odds_override != null && !isNaN(parseFloat(b.odds_override))) {
        displayOdds = parseFloat(b.odds_override).toFixed(2);
      } else if (b.odds != null && !isNaN(parseFloat(b.odds))) {
        displayOdds = parseFloat(b.odds).toFixed(2);
      }

      return [
        b.bet_id || '',
        b.date || '-',
        b.bookie || '-',
        b.event || '-',
        b.bet || '-',
        displayOdds,
        (typeof b.stake === 'number') ? b.stake.toFixed(2) : '-',
        b.result || '',
        b.profit != null ? b.profit.toFixed(2) : '',
        b.settle_date || '-',
	  // === NOTES ADDITION ===
	  b.notes       || ''
	  // === END NOTES ADDITION ===
      ];
    });

    // Initialize DataTable with numeric sort on ID, descending, hide UI via CSS
    $('#ev-bets-table').DataTable({
      destroy: true,
      data: rows,
      columns: [
        { data: 0, title: 'ID',          className: 'all column-id'     },
        { data: 1, title: 'Date',        className: 'all'     },
        { data: 2, title: 'Bookie',      className: 'all'     },
        { data: 3, title: 'Event',       className: 'desktop' },
        { data: 4, title: 'Bet',         className: 'all'     },
        { data: 5, title: 'Odds',        className: 'all column-odds'     },
        {
          data: 6,
          title: 'Stake',
          className: 'desktop',
          render: (data, type) => (type === 'display' && data) ? '£' + data : data
        },
        {
          data: 7,
          title: 'W/L',
          className: 'all column-wl',
          createdCell: (td, v) => $(td).css('background-color',
            v === 'W' ? '#D6E3BC' : v === 'L' ? '#E5B8B7' : '#FFE5A0'
          )
        },
        {
          data: 8,
          title: 'P/L',
          className: 'desktop',
          render: (data, type) => (type === 'display' && data) ? '£' + data : data
        },
        { data: 9, title: 'Settle Date', className: 'desktop' },
		// === NOTES ADDITION ===
		{ data: 10, title: 'Notes',      className: 'desktop'     }
		// === END NOTES ADDITION ===
      ],
      columnDefs: [
        { targets: 0, type: 'num' }
      ],
      order: [[0, 'desc']],       // numeric descending by ID
      responsive: { details: { type: 'inline' } },
      ordering: true,
      pageLength: 10,
      searching: false
    });

    // Add class to suppress click and icons via CSS
    $('#ev-bets-table').addClass('no-sort-ui');

  }).fail(function(xhr) {
    $('#ev-bets-table').parent().prepend(
      `<p class="error">Unable to load bets (${xhr.status}).</p>`
    );
  });

  function renderStats(stats, wrapper) {
    const kpi = $('<div class="ev-kpi-container" ' +
      'style="flex:1.3; display:grid; grid-template-columns:repeat(2,1fr); gap:1rem;"/>' );
    [
      { key: 'total_staked',       label: 'Total Staked',      prefix: '£' },
      { key: 'total_profit',       label: 'Total Profit',      prefix: '£' },
      { key: 'roi',                label: 'ROI',               prefix: ''  },
      { key: 'bankroll_growth_pc', label: 'Bankroll Growth',   prefix: ''  }
    ].forEach(i => {
      const val = i.key === 'roi'
        ? `${stats[i.key]}%`
        : `${i.prefix}${stats[i.key]}`;
      kpi.append(
        `<div style="padding:1rem; border:1px solid #ddd; border-radius:4px; text-align:center;">
           <div style="font-size:0.9rem; color:#555; margin-bottom:0.5rem;">${i.label}</div>
           <div style="font-size:1.25rem; font-weight:bold;">${val}</div>
         </div>`
      );
    });
    wrapper.append(kpi);
  }

  function renderChart(bets, wrapper) {
    const chartDiv = $('<div class="ev-chart-container" ' +
      'style="flex:1; display:flex; flex-direction:column;"/>' );
    const canvas = $('<canvas class="ev-chart-canvas" ' +
      'style="flex:1; width:100%; height:100%;"/>' );
    chartDiv.append(canvas); wrapper.append(chartDiv);

    // Build cumulative P/L dataset
    const sorted = bets.slice().sort((a, b) => {
      const idA = parseInt(a.bet_id.replace(/,/g, ''), 10) || 0;
      const idB = parseInt(b.bet_id.replace(/,/g, ''), 10) || 0;
      return idA - idB;
    });
    let cum = 0, labels = [], pts = [];
    sorted.forEach(b => {
      if (['W','L'].includes(b.result)) {
        cum += parseFloat(b.profit);
        labels.push(b.bet_id);
        pts.push(cum.toFixed(2));
      }
    });

    new Chart(canvas[0].getContext('2d'), {
      type: 'line',
      data: { labels, datasets: [{ label:'Cumulative P/L', data:pts, fill:false, borderColor:'#A3BF69', borderWidth:2, tension:0.4, pointRadius:0 }] },
      options: {
        responsive:true, maintainAspectRatio:false,
        interaction:{mode:'index',intersect:false},
        scales:{ x:{display:false}, y:{ticks:{callback:v=>'£'+v}} },
        plugins:{ legend:{display:false}, tooltip:{callbacks:{title:i=>`Bet #${i[0].label}`, label:i=>`P/L: £${i[0].formattedValue}`}} }
      }
    });
  }
});