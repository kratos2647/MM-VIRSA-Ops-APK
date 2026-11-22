/**
 * js/app.js
 * MM VIRSA — Warm Editorial Operations Portal Controller
 * Features:
 *  - Dedicated Visual Dashboard (Greeting, 4 KPI Cards, Semi-Circular Arc Gauge, Orders Bar Chart)
 *  - Clean Keitoto Orders Table (All, Booked, Transit, 5d, 10d, RTO, Delivered, Returned)
 *  - Dedicated CSV & Excel (.csv / .xlsx / .xls) Upload Sheet (Auto, Load Sheet, Receiving Sheet)
 *  - Warm Luxury Return Scanner (1080p 20 FPS + BarcodeDetector + Torch/Zoom + USB Wedge)
 *  - 5-Day & 10-Day SLA Escalations + Trax Sonic v2.0 & Leopards Live Tracking Drawer
 *  - Continuous Cloud Sync (Zero topbar timer, Zero form-input overwrite bug!)
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  const VIEW_TITLES = {
    dashboard: 'Dashboard',
    overview: 'Orders',
    upload: 'Upload Sheet',
    returns: 'Scanner',
    alerts: 'Alerts',
    reports: 'Reports',
    settings: 'Settings'
  };

  const SHEET_MODE_HINTS = {
    auto: 'Auto-detects Trax Sonic & Leopards columns, exact status, COD amount, destination city & phone.',
    load_sheet: 'Load Sheet Mode: Marks booked / pickup-request parcels as "Booked / Pickup" until handed over.',
    receiving_sheet: 'Receiving Sheet Mode: Marks parcels as "In Transit" & automatically upgrades Booked parcels to Dispatched.'
  };

  const ui = {
    activeView: 'dashboard',
    statusTab: 'all',
    page: 1,
    pageSize: 12,
    gateOpen: false,
    gateMode: 'dispatch', // 'dispatch' | 'booked' | 'return'
    gateManualCourier: false,
    scannerMode: 'return', // 'return' | 'dispatch'
    sheetMode: 'auto', // 'auto' | 'load_sheet' | 'receiving_sheet'
    pendingCSVRows: [],
    pendingCSVFormat: '',
    alertTab: 'critical10',
    alertCourier: 'All',
    activeDrawerCN: '',
    activeDrawerCourier: '',
    lastDupCN: '',
    pendingUnknownCN: '',
    pendingAdminAction: null,
    isSyncing: false,
    intakeFeed: [],
    session: { valid: 0, dup: 0, leopards: 0, trax: 0, log: [] }
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(msg, type) {
    const box = $('toast-container');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `toast ${type || 'success'}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s';
      setTimeout(() => el.remove(), 220);
    }, 3200);
  }

  function flashScreen(cls) {
    const el = $('screen-flash');
    if (!el) return;
    el.className = 'screen-flash';
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function nowClock() {
    return new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  // =========================================================================
  // View Navigation & Quick Gate Toggle
  // =========================================================================
  function setGateDrawerOpen(open, focusInput) {
    ui.gateOpen = Boolean(open);
    const box = $('gate-drawer-box');
    if (box) box.classList.toggle('open', ui.gateOpen);
    const lbl = $('btn-toggle-gate-label');
    if (lbl) lbl.textContent = ui.gateOpen ? 'Close' : 'New Order';
    if (ui.gateOpen && focusInput) {
      setTimeout(() => {
        const inp = $('inp-gate-cn');
        if (inp) inp.focus();
      }, 45);
    }
  }

  function setStatusTab(tab) {
    ui.statusTab = tab || 'all';
    ui.page = 1;
    document.querySelectorAll('#status-underline-tabs [data-status-tab]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-status-tab') === ui.statusTab);
    });
    document.querySelectorAll('[data-kpi-filter]').forEach((k) => {
      k.classList.toggle('is-selected', k.getAttribute('data-kpi-filter') === ui.statusTab);
    });
    renderLedger(App.Storage.getParcels());
  }

  async function switchView(viewName) {
    if (ui.activeView !== viewName) {
      await App.Scanner.stop();
      updateReturnCamUI(false);
    }
    ui.activeView = viewName;
    document.querySelectorAll('.view-section').forEach((s) => {
      s.classList.toggle('active', s.id === `view-${viewName}`);
    });
    document.querySelectorAll('[data-nav]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-nav') === viewName);
    });
    const bc = $('breadcrumb-current');
    if (bc) bc.textContent = VIEW_TITLES[viewName] || 'Dashboard';

    $('notif-dropdown').classList.remove('open');
    renderAll();

    if (viewName === 'returns') {
      setTimeout(() => $('inp-return-scan').focus(), 60);
    } else if (viewName === 'overview' && ui.gateOpen) {
      setTimeout(() => $('inp-gate-cn').focus(), 60);
    }
    global.scrollTo({ top: 0, behavior: 'instant' });
  }

  // =========================================================================
  // Couriers & Dropdowns
  // =========================================================================
  function getCouriers() {
    return App.Couriers.getCouriers(App.Storage.getState().customCouriers);
  }

  function syncCourierControls() {
    const list = getCouriers();
    const sig = list.map((c) => c.name).join('|');

    const fSel = $('filter-courier');
    if (fSel && fSel.dataset.sig !== sig) {
      const prevF = fSel.value || 'All';
      fSel.innerHTML =
        `<option value="All">All Couriers</option>` +
        list.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
      if ([...fSel.options].some((o) => o.value === prevF)) fSel.value = prevF;
      fSel.dataset.sig = sig;
    }

    ['inp-gate-courier', 'edit-courier', 'inp-unknown-courier'].forEach((id) => {
      const sel = $(id);
      if (!sel || sel.dataset.sig === sig) return;
      const prev = sel.value;
      sel.innerHTML = list.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      sel.dataset.sig = sig;
    });

    const names = ['All', ...list.map((c) => c.name)];
    $('alerts-courier-pills').innerHTML = names
      .map(
        (n) =>
          `<button type="button" class="seg-btn ${ui.alertCourier === n ? 'active' : ''}" data-alert-courier="${esc(n)}">${esc(n)}</button>`
      )
      .join('');

    $('courier-list-chips').innerHTML = list
      .map((c) => {
        const del = c.builtIn
          ? ''
          : `<button type="button" data-remove-courier="${esc(c.name)}" style="border:none;background:none;color:var(--red-text);font-weight:700;padding:0 0 0 4px;">&times;</button>`;
        return `<span class="chip chip-neutral">${esc(c.name)}${del}</span>`;
      })
      .join('');
  }

  // =========================================================================
  // Dashboard Renderer (KPI Cards, Semi-Circular Arc & Orders Dynamics Chart)
  // =========================================================================
  function renderDashboard(sum) {
    const totalCount = sum.totalDispatched;
    const overdueCount = sum.warning5 + sum.critical10;
    const activeCount = sum.inTransitNormal + overdueCount;
    const transitPct = totalCount > 0 ? Math.round((sum.inTransitNormal / totalCount) * 100) : 0;
    const deliveredPct = totalCount > 0 ? Math.round((sum.delivered / totalCount) * 100) : 0;
    const activePct = totalCount > 0 ? Math.round(((activeCount + sum.booked) / totalCount) * 100) : 0;

    $('dkpi-total').textContent = totalCount.toLocaleString();
    $('dkpi-transit').textContent = sum.inTransitNormal.toLocaleString();
    $('dkpi-booked').textContent = sum.booked.toLocaleString();
    $('dkpi-delivered').textContent = sum.delivered.toLocaleString();

    $('dkpi-pill-total').textContent = sum.returnedVerified > 0 ? `${sum.returnedVerified} ret` : 'Live';
    $('dkpi-pill-transit').textContent = `${transitPct}%`;
    $('dkpi-pill-booked').textContent = sum.booked > 0 ? 'Pending' : 'Clear';
    $('dkpi-pill-delivered').textContent = `${deliveredPct}%`;

    // Live Semi-Circular Arc Gauge
    const ARC_LEN = 276.46;
    const primaryArc = totalCount > 0 ? ((activeCount + sum.booked) / totalCount) * ARC_LEN : 0;
    const combinedArc = totalCount > 0 ? ((activeCount + sum.booked + sum.delivered) / totalCount) * ARC_LEN : 0;
    $('arc-active-pct').textContent = `${activePct}%`;
    $('arc-total').textContent = totalCount.toLocaleString();
    $('arc-transit').textContent = sum.inTransitNormal.toLocaleString();
    $('arc-overdue').textContent = overdueCount.toLocaleString();
    $('arc-delivered').textContent = sum.delivered.toLocaleString();
    $('arc-seg-transit').setAttribute('stroke-dasharray', `${combinedArc.toFixed(1)} 280`);
    $('arc-seg-delivered').setAttribute('stroke-dasharray', `${primaryArc.toFixed(1)} 280`);

    // Orders Dynamics Vertical Bar Chart
    const chartBox = $('dash-bar-chart');
    if (chartBox) {
      const series = sum.dailySeries || [];
      if (series.length === 0) {
        chartBox.innerHTML = `<div class="empty-state" style="width:100%; padding:28px 0;">Upload a Trax or Leopards sheet to see volume dynamics</div>`;
      } else {
        const maxVal = Math.max(1, ...series.map((d) => d.count));
        let peakIdx = series.length - 1;
        series.forEach((d, idx) => {
          if (d.count >= series[peakIdx].count) peakIdx = idx;
        });

        chartBox.innerHTML = series
          .map((d, idx) => {
            const pct = Math.max(12, Math.round((d.count / maxVal) * 100));
            const isPeak = idx === peakIdx;
            return `
              <div class="bar-col ${isPeak ? 'is-peak' : ''}">
                <div class="bar-track">
                  <div class="bar-fill" style="height:${pct}%;">
                    ${isPeak ? `<span class="bar-val-pill">${d.count}</span>` : ''}
                  </div>
                </div>
                <span class="bar-lbl">${esc(d.label)}</span>
              </div>
            `;
          })
          .join('');
      }
    }

    const codTxt = sum.totalCodAmount > 0 ? `COD Value: Rs. ${sum.totalCodAmount.toLocaleString()}` : 'Trax & Leopards volume';
    $('dash-cod-summary').textContent = codTxt;
    $('dash-split-leopards').textContent = `Leopards: ${sum.leopardsCount}`;
    $('dash-split-trax').textContent = `Trax: ${sum.traxCount}`;
    $('dash-split-rto').textContent = `RTO: ${sum.rto}`;

    $('dquick-booked').textContent = sum.booked.toLocaleString();
    $('dquick-rto').textContent = sum.rto.toLocaleString();
    $('dquick-overdue').textContent = overdueCount.toLocaleString();
  }

  // =========================================================================
  // Master Render (Never Overwrites User Form Inputs!)
  // =========================================================================
  function renderAll() {
    const state = App.Storage.getState();
    const parcels = state.parcels;
    const sum = App.Aging.summarize(parcels);

    $('demo-banner').style.display = state.isSampleData ? 'flex' : 'none';
    syncCourierControls();
    renderDashboard(sum);

    // Orders View KPI Strip
    const totalCount = sum.totalDispatched;
    const overdueCount = sum.warning5 + sum.critical10;
    const transitPct = totalCount > 0 ? Math.round((sum.inTransitNormal / totalCount) * 100) : 0;
    const deliveredPct = totalCount > 0 ? Math.round((sum.delivered / totalCount) * 100) : 0;

    $('kpi-total').textContent = totalCount.toLocaleString();
    $('kpi-normal').textContent = sum.inTransitNormal.toLocaleString();
    $('kpi-overdue').textContent = overdueCount.toLocaleString();
    $('kpi-delivered').textContent = sum.delivered.toLocaleString();

    if ($('kpi-pill-total')) $('kpi-pill-total').textContent = sum.returnedVerified > 0 ? `${sum.returnedVerified} ret` : 'Live';
    if ($('kpi-pill-transit')) $('kpi-pill-transit').textContent = `${transitPct}%`;
    if ($('kpi-pill-overdue')) $('kpi-pill-overdue').textContent = overdueCount > 0 ? `${overdueCount} due` : 'Clear';
    if ($('kpi-pill-delivered')) $('kpi-pill-delivered').textContent = `${deliveredPct}%`;

    // Underline Tab Counts
    $('utab-all').textContent = sum.totalDispatched;
    $('utab-booked').textContent = sum.booked;
    $('utab-normal').textContent = sum.inTransitNormal;
    $('utab-warning5').textContent = sum.warning5;
    $('utab-critical10').textContent = sum.critical10;
    $('utab-rto').textContent = sum.rto;
    $('utab-delivered').textContent = sum.delivered;
    $('utab-returned').textContent = sum.returnedVerified;

    document.querySelectorAll('[data-kpi-filter]').forEach((k) => {
      k.classList.toggle('is-selected', k.getAttribute('data-kpi-filter') === ui.statusTab);
    });

    // Nav & Bell Counts
    $('nav-count-returns').textContent = sum.returnedVerified;
    $('nav-count-alerts').textContent = sum.totalActionNeeded;
    const bBot = $('bottom-badge-alerts');
    bBot.textContent = sum.totalActionNeeded;
    bBot.classList.toggle('hidden', sum.totalActionNeeded === 0);

    const bellCnt = sum.todayAlertsCount > 0 ? sum.todayAlertsCount : sum.totalActionNeeded;
    const bellEl = $('bell-badge');
    bellEl.textContent = bellCnt;
    bellEl.classList.toggle('hidden', bellCnt === 0);

    renderNotifications(sum);
    renderIntakeFeed(parcels);
    renderLedger(parcels);
    renderAlertsView(sum);
    renderApiAndSecurity();
  }

  function renderNotifications(sum) {
    $('notif-d5').textContent = sum.warning5;
    $('notif-d10').textContent = sum.critical10;
    const items = [...sum.allCritical10.slice(0, 4), ...sum.allWarning5.slice(0, 3)];
    const list = $('notif-list');
    if (items.length === 0) {
      list.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:12px;">No SLA breaches today.</div>`;
      return;
    }
    list.innerHTML = items
      .map(
        ({ parcel, eval: ev }) => `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border:1px solid var(--border-subtle); border-radius:8px; cursor:pointer;" data-action="track" data-cn="${esc(parcel.trackingNumber)}" data-courier="${esc(parcel.courier)}">
        <div>
          <div class="mono" style="font-weight:600; font-size:12px;">${esc(parcel.trackingNumber)}</div>
          <div style="font-size:11px; color:var(--text-muted);">${esc(parcel.courier)} • ${esc(parcel.orderId || '—')}</div>
        </div>
        <span class="chip ${ev.tier === 'critical10' ? 'chip-red' : 'chip-amber'}">Day ${ev.days}</span>
      </div>
    `
      )
      .join('');
  }

  function pushIntakeEvent(ev) {
    ui.intakeFeed.unshift(ev);
    if (ui.intakeFeed.length > 25) ui.intakeFeed.pop();
  }

  function renderIntakeFeed(parcels) {
    const box = $('live-intake-feed');
    if (!box) return;
    const items =
      ui.intakeFeed.length > 0
        ? ui.intakeFeed.slice(0, 3)
        : parcels.slice(0, 3).map((p) => ({
            cn: p.trackingNumber,
            courier: p.courier,
            sub: `${p.customerName || p.orderId || 'Manifest'} • ${App.Aging.formatDisplayDate(p.dispatchDate)}`,
            status: p.status === 'Returned & Verified' ? 'Returned' : p.status === 'Delivered' ? 'Delivered' : p.status === 'Booked / Pickup' ? 'Booked' : 'Dispatched',
            chipCls: p.status === 'Returned & Verified' ? 'chip-purple' : p.status === 'Delivered' ? 'chip-green' : p.status === 'Booked / Pickup' ? 'chip-amber' : 'chip-blue',
            time: App.Aging.formatDisplayDate(p.dispatchDate),
            isDup: false
          }));

    if (items.length === 0) {
      box.innerHTML = `<div class="empty-state" style="padding:14px;">Recent scans will appear here.</div>`;
      return;
    }

    box.innerHTML = items
      .map(
        (it) => `
      <div class="feed-row ${it.isDup ? 'is-dup' : ''}">
        <div style="min-width:0;">
          <div style="display:flex; align-items:center; gap:6px;">
            <button type="button" class="cn-btn mono" data-action="track" data-cn="${esc(it.cn)}" data-courier="${esc(it.courier)}">${esc(it.cn)}</button>
            <span class="chip chip-neutral" style="font-size:10.5px;">${esc(it.courier)}</span>
          </div>
          <div style="font-size:11.5px; color:${it.isDup ? 'var(--red-text)' : 'var(--text-muted)'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(it.sub)}</div>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <span class="chip ${it.chipCls}">${esc(it.status)}</span>
          <div class="mono" style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">${esc(it.time)}</div>
        </div>
      </div>
    `
      )
      .join('');
  }

  function getFilteredParcels(parcels) {
    const q = ($('filter-search').value || '').trim().toLowerCase();
    const courier = $('filter-courier').value || 'All';
    const status = ui.statusTab || 'all';
    return parcels.filter((p) => {
      if (courier !== 'All' && p.courier.toLowerCase() !== courier.toLowerCase()) return false;
      const ev = App.Aging.evaluateParcel(p);
      if (status === 'booked' && ev.tier !== 'booked') return false;
      if (status === 'normal' && ev.tier !== 'normal') return false;
      if (status === 'overdue' && ev.tier !== 'warning5' && ev.tier !== 'critical10') return false;
      if (status === 'warning5' && ev.tier !== 'warning5') return false;
      if (status === 'critical10' && ev.tier !== 'critical10') return false;
      if (status === 'rto' && ev.tier !== 'rto') return false;
      if (status === 'delivered' && ev.tier !== 'delivered') return false;
      if (status === 'returned' && ev.tier !== 'returned') return false;
      if (q) {
        const hay = `${p.trackingNumber} ${p.orderId} ${p.customerName} ${p.customerPhone} ${p.destinationCity || ''} ${p.courier} ${p.courierStatus || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function courierThumbHTML(courierName) {
    const low = String(courierName || '').toLowerCase();
    if (low.includes('leopard')) return `<div class="courier-thumb leopards">LP</div>`;
    if (low.includes('trax')) return `<div class="courier-thumb trax">TX</div>`;
    const initials = String(courierName || 'CR').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'CR';
    return `<div class="courier-thumb">${esc(initials)}</div>`;
  }

  function ageTagHTML(ev) {
    if (ev.tier === 'delivered' || ev.tier === 'returned' || ev.tier === 'cancelled' || ev.tier === 'booked') return '';
    const cls = ev.tier === 'critical10' ? 'red' : ev.tier === 'warning5' ? 'amber' : '';
    return `<span class="age-tag ${cls}">${ev.days}d</span>`;
  }

  function statusChipHTML(ev) {
    if (ev.tier === 'critical10') return `<span class="chip chip-red">10d Overdue</span>`;
    if (ev.tier === 'warning5') return `<span class="chip chip-amber">5d Alert</span>`;
    if (ev.tier === 'booked') return `<span class="chip chip-yellow">Pending</span>`;
    if (ev.tier === 'rto') return `<span class="chip chip-purple">Returning</span>`;
    if (ev.tier === 'delivered') return `<span class="chip chip-green">Delivered</span>`;
    if (ev.tier === 'returned') return `<span class="chip chip-purple">Returned</span>`;
    if (ev.tier === 'cancelled') return `<span class="chip chip-neutral">Cancelled</span>`;
    return `<span class="chip chip-blue">Processing</span>`;
  }

  function renderPagination(totalItems) {
    const infoEl = $('pagination-info');
    const ctrlEl = $('pagination-controls');
    if (!infoEl || !ctrlEl) return;

    const totalPages = Math.max(1, Math.ceil(totalItems / ui.pageSize));
    if (ui.page > totalPages) ui.page = totalPages;

    if (totalItems === 0) {
      infoEl.textContent = 'Showing 0 orders';
      ctrlEl.innerHTML = '';
      return;
    }

    const start = (ui.page - 1) * ui.pageSize + 1;
    const end = Math.min(totalItems, ui.page * ui.pageSize);
    infoEl.textContent = `Showing ${start}–${end} of ${totalItems} orders`;

    const pages = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (ui.page > 3) pages.push('...');
      const from = Math.max(2, ui.page - 1);
      const to = Math.min(totalPages - 1, ui.page + 1);
      for (let i = from; i <= to; i++) pages.push(i);
      if (ui.page < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }

    let html = `<button type="button" class="page-btn" data-page="${ui.page - 1}" ${ui.page <= 1 ? 'disabled' : ''}>‹ Previous</button>`;
    pages.forEach((p) => {
      if (p === '...') html += `<span style="padding:0 4px; color:var(--text-muted);">…</span>`;
      else html += `<button type="button" class="page-btn ${p === ui.page ? 'active' : ''}" data-page="${p}">${p}</button>`;
    });
    html += `<button type="button" class="page-btn" data-page="${ui.page + 1}" ${ui.page >= totalPages ? 'disabled' : ''}>Next ›</button>`;
    ctrlEl.innerHTML = html;
  }

  function renderLedger(allParcels) {
    const allFiltered = getFilteredParcels(allParcels);
    const totalPages = Math.max(1, Math.ceil(allFiltered.length / ui.pageSize));
    if (ui.page > totalPages) ui.page = totalPages;

    const startIdx = (ui.page - 1) * ui.pageSize;
    const rows = allFiltered.slice(startIdx, startIdx + ui.pageSize);

    const tbody = $('ledger-tbody');
    const mob = $('ledger-mobile');
    renderPagination(allFiltered.length);

    if (rows.length === 0) {
      const empty = `<div class="empty-state">No orders found.</div>`;
      tbody.innerHTML = `<tr><td colspan="5">${empty}</td></tr>`;
      mob.innerHTML = empty;
      return;
    }

    tbody.innerHTML = rows
      .map((p) => {
        const ev = App.Aging.evaluateParcel(p);
        const destTxt = p.customerName || p.destinationCity || p.courier;
        const citySub = p.destinationCity && p.customerName ? ` • ${p.destinationCity}` : '';
        const orderLabel = p.orderId ? (String(p.orderId).startsWith('#') ? p.orderId : `#${p.orderId}`) : p.courier;

        return `
          <tr>
            <td>
              <div class="shipment-cell">
                ${courierThumbHTML(p.courier)}
                <div style="min-width:0;">
                  <button type="button" class="cn-btn mono" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">${esc(p.trackingNumber)}</button>
                  <div style="font-size:12px; color:var(--text-muted); margin-top:1px;">${esc(orderLabel)}${p.codAmount ? ' • Rs. ' + Number(p.codAmount).toLocaleString() : ''}</div>
                </div>
              </div>
            </td>
            <td style="color:var(--text-primary); font-weight:500;">
              <div style="max-width:220px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(destTxt)}<span style="color:var(--text-muted); font-weight:400;">${esc(citySub)}</span></div>
            </td>
            <td>${statusChipHTML(ev)}</td>
            <td class="mono" style="font-size:12.5px; color:var(--text-secondary); white-space:nowrap;">${esc(p.dispatchDate || '')}${ageTagHTML(ev)}</td>
            <td style="text-align:right; white-space:nowrap;">
              <button type="button" class="row-icon-btn" title="Live Track" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              <button type="button" class="row-icon-btn" title="Edit Order" data-action="edit" data-id="${esc(p.id)}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
              </button>
            </td>
          </tr>
        `;
      })
      .join('');

    mob.innerHTML = rows
      .map((p) => {
        const ev = App.Aging.evaluateParcel(p);
        const destTxt = p.customerName || p.destinationCity || p.courier;
        const orderLabel = p.orderId ? (String(p.orderId).startsWith('#') ? p.orderId : `#${p.orderId}`) : p.courier;
        return `
          <div class="mobile-row">
            <div class="mob-card-top">
              <div class="shipment-cell" style="min-width:0;">
                ${courierThumbHTML(p.courier)}
                <div style="min-width:0;">
                  <button type="button" class="cn-btn mono" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">${esc(p.trackingNumber)}</button>
                  <div style="font-size:11.5px; color:var(--text-muted); margin-top:1px;">${esc(orderLabel)}${p.codAmount ? ' • Rs. ' + Number(p.codAmount).toLocaleString() : ''}</div>
                </div>
              </div>
              ${statusChipHTML(ev)}
            </div>
            <div class="mob-card-bottom">
              <div style="min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                <span style="color:var(--text-primary); font-weight:500;">${esc(destTxt)}</span>
                <span style="margin:0 5px; opacity:0.4;">•</span>
                <span class="mono">${esc(p.dispatchDate || '')}</span>${ageTagHTML(ev)}
              </div>
              <div style="display:inline-flex; align-items:center; gap:2px; flex-shrink:0;">
                <button type="button" class="row-icon-btn" title="Live Track" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
                <button type="button" class="row-icon-btn" title="Edit Order" data-action="edit" data-id="${esc(p.id)}">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderAlertsView(sum) {
    const filterFn = (x) => ui.alertCourier === 'All' || x.parcel.courier.toLowerCase() === ui.alertCourier.toLowerCase();
    const list10 = sum.allCritical10.filter(filterFn);
    const list5 = sum.allWarning5.filter(filterFn);
    $('tab-count-10d').textContent = list10.length;
    $('tab-count-5d').textContent = list5.length;

    const activeList = ui.alertTab === 'critical10' ? list10 : list5;
    const container = $('alerts-list-container');
    if (activeList.length === 0) {
      container.innerHTML = `<div class="empty-state">No parcels in this SLA alert tier.</div>`;
      return;
    }

    container.innerHTML = activeList
      .map(
        ({ parcel: p, eval: ev }) => `
      <div class="feed-row">
        <div style="min-width:0;">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <button type="button" class="cn-btn mono" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">${esc(p.trackingNumber)}</button>
            <span class="chip chip-neutral">${esc(p.courier)}</span>
            ${statusChipHTML(ev)}
            <span class="mono" style="font-size:11px; color:var(--text-muted);">Day ${ev.days}</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-top:3px;">
            ${esc(p.orderId || '—')} • ${esc(p.customerName || 'No Name')} ${p.destinationCity ? '• ' + esc(p.destinationCity) : ''} • ${esc(App.Aging.formatDisplayDate(p.dispatchDate))}
          </div>
        </div>
        <div class="btn-group">
          <button type="button" class="btn btn-sm" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">Live Track</button>
          <button type="button" class="btn btn-sm" data-action="deliver" data-id="${esc(p.id)}">Delivered</button>
          <button type="button" class="btn btn-sm btn-primary" data-action="verify-return" data-id="${esc(p.id)}">Verify Return</button>
        </div>
      </div>
    `
      )
      .join('');
  }

  // =========================================================================
  // Settings Form Hydration (Called ONLY on Init & Explicit Save — NEVER on 8s Poll!)
  // =========================================================================
  function hydrateSettingsForms() {
    const apiCfg = App.TrackingAPI.loadConfig();
    $('inp-trax-key').value = apiCfg.traxApiKey || '';
    $('inp-trax-env').value = apiCfg.traxEnv || 'live';
    $('inp-api-proxy').value = apiCfg.corsProxyUrl || '';
    $('inp-lcs-key').value = apiCfg.leopardsApiKey || '';
    $('inp-lcs-pass').value = apiCfg.leopardsApiPassword || '';
    $('chk-auto-deliver').checked = Boolean(apiCfg.autoMarkDeliveredOnSync);

    if (App.CloudSync) {
      const sc = App.CloudSync.loadConfig();
      $('inp-sync-provider').value = sc.provider || 'google_sheets';
      $('inp-sync-url').value = sc.endpointUrl || '';
      $('inp-sync-secret').value = sc.secretToken || '';
      $('chk-cloud-sync-enabled').checked = Boolean(sc.enabled);
    }

    const sec = App.Security.loadConfig();
    $('inp-sec-autolock').value = String(sec.autoLockMinutes || 0);
    $('inp-sec-operator').value = sec.operatorName || 'VIRSA Station';
  }

  function renderApiAndSecurity() {
    const apiCfg = App.TrackingAPI.loadConfig();
    const traxOk = App.TrackingAPI.hasLiveCredentials('Trax', apiCfg);
    const lcsOk = App.TrackingAPI.hasLiveCredentials('Leopards', apiCfg);
    const localProxy = App.TrackingAPI.isLocalProxyActive();

    $('local-proxy-banner').style.display = localProxy ? 'none' : 'flex';
    $('proxy-status-badge').textContent = localProxy ? 'Zero-CORS Proxy ON' : 'Direct Mode';
    $('proxy-status-badge').className = localProxy ? 'chip chip-green' : 'chip chip-amber';
    $('trax-cred-badge').textContent = traxOk ? 'Live Key Saved' : 'Not Set';
    $('trax-cred-badge').className = traxOk ? 'chip chip-green' : 'chip chip-neutral';
    $('leopards-cred-badge').textContent = lcsOk ? 'Live Key Saved' : 'Not Set';
    $('leopards-cred-badge').className = lcsOk ? 'chip chip-green' : 'chip chip-neutral';

    // Clean Topbar Sync Label — ZERO clock/timer!
    const scTop = App.CloudSync ? App.CloudSync.loadConfig() : null;
    const isCloudBusy = ui.isSyncing || (App.CloudSync && App.CloudSync.isSyncing());
    const cloudActive = Boolean(scTop && scTop.enabled && scTop.endpointUrl && !scTop.lastError);
    $('topbar-sync-label').textContent = isCloudBusy ? 'Syncing' : cloudActive ? 'Synced' : 'Sync';

    const sideSync = $('sidebar-sync-status');
    if (sideSync) {
      const dotColor = scTop && scTop.enabled && scTop.lastError ? 'var(--red-solid)' : 'var(--green-text)';
      const lbl =
        scTop && scTop.enabled
          ? scTop.lastError
            ? 'Sync Error'
            : 'Cloud Sync ON'
          : localProxy
          ? 'Local Disk ON'
          : 'Live Ready';
      sideSync.innerHTML = `<span class="live-dot" style="background:${dotColor};"></span>${lbl}`;
    }

    if (App.CloudSync) {
      const sc = App.CloudSync.loadConfig();
      const hasDisk = App.CloudSync.hasLocalDiskBackend();
      $('disk-db-badge').textContent = hasDisk ? 'Local Disk DB: ACTIVE' : 'Browser LocalStorage';
      $('disk-db-badge').className = hasDisk ? 'chip chip-green' : 'chip chip-neutral';

      const cloudOn = Boolean(sc.enabled && sc.endpointUrl);
      $('cloud-sync-badge').textContent = App.CloudSync.isSyncing()
        ? 'Syncing...'
        : cloudOn
        ? sc.lastError
          ? 'Sync Error'
          : 'Cloud Synced'
        : 'Cloud Off';
      $('cloud-sync-badge').className = cloudOn
        ? sc.lastError
          ? 'chip chip-red'
          : 'chip chip-green'
        : 'chip chip-neutral';

      if (sc.lastError) {
        $('cloud-sync-meta').innerHTML = `<span style="color:var(--red-text); font-weight:600;">Last Cloud Sync Error: ${esc(sc.lastError)}</span>`;
      } else if (sc.lastCloudSyncAt) {
        $('cloud-sync-meta').textContent = `Continuous two-way cloud sync active • Last synced ${App.Aging.formatDateTime(sc.lastCloudSyncAt)}`;
      }
    }

    const sec = App.Security.loadConfig();
    const opName = sec.operatorName || 'VIRSA Station';
    $('sidebar-operator-name').textContent = opName;
    if ($('dash-hello-name')) $('dash-hello-name').textContent = opName.split(/\s+/)[0] || 'VIRSA';

    $('btn-lock-app').style.display = sec.pinEnabled ? 'inline-flex' : 'none';
    $('btn-sec-lock-now').style.display = sec.pinEnabled ? 'inline-flex' : 'none';
    $('btn-sec-disable-pin').style.display = sec.pinEnabled ? 'inline-flex' : 'none';
    $('sec-pin-status-badge').textContent = sec.pinEnabled ? 'PIN Protected' : 'PIN Off';
    $('sec-pin-status-badge').className = sec.pinEnabled ? 'chip chip-green' : 'chip chip-neutral';

    const logs = App.Security.getAuditLog();
    $('audit-count-pill').textContent = logs.length;
    $('audit-log-box').innerHTML = logs.length
      ? logs
          .slice(0, 40)
          .map(
            (r) => `
        <div class="audit-row">
          <div><span class="chip ${/FAIL|DUP|DELETE|CLEAR/.test(r.type) ? 'chip-red' : 'chip-neutral'}" style="margin-right:6px;">${esc(r.type)}</span>${esc(r.detail)}</div>
          <span class="mono" style="color:var(--text-muted); font-size:10.5px; flex-shrink:0;">${esc(App.Aging.formatDateTime(r.ts))}</span>
        </div>
      `
          )
          .join('')
      : `<div class="empty-state" style="padding:16px;">No audit events yet.</div>`;
  }

  // =========================================================================
  // Upload Sheet Preview Renderer (CSV & Excel — Trax / Leopards)
  // =========================================================================
  function renderCSVPreview() {
    if (!ui.pendingCSVRows.length) {
      $('csv-preview-panel').style.display = 'none';
      return;
    }

    const updateExisting = $('chk-csv-update-existing').checked;
    const skipCancelled = $('chk-csv-skip-cancelled').checked;
    const existingMap = new Map();
    App.Storage.getParcels().forEach((p) => {
      existingMap.set(App.Couriers.normalizeTracking(p.trackingNumber), p);
    });
    const seen = new Set();

    let newCnt = 0;
    let updCnt = 0;
    let skipCnt = 0;
    const previewRows = [];

    ui.pendingCSVRows.forEach((r) => {
      const cn = App.Couriers.normalizeTracking(r.trackingNumber);
      let effectiveStatus = r.status || 'In Transit';
      if (ui.sheetMode === 'load_sheet' && !['Delivered', 'Cancelled', 'Returned & Verified'].includes(effectiveStatus)) {
        effectiveStatus = 'Booked / Pickup';
      } else if (ui.sheetMode === 'receiving_sheet' && !['Delivered', 'Cancelled', 'Returned & Verified'].includes(effectiveStatus)) {
        effectiveStatus = 'In Transit';
      }

      let actionTag = 'New';
      let actionCls = 'chip-green';

      if (!cn || seen.has(cn) || (skipCancelled && effectiveStatus === 'Cancelled')) {
        skipCnt++;
        actionTag = skipCancelled && effectiveStatus === 'Cancelled' ? 'Skip Cancel' : 'Skip Dup';
        actionCls = 'chip-neutral';
      } else {
        seen.add(cn);
        const ex = existingMap.get(cn);
        if (ex) {
          if (updateExisting) {
            updCnt++;
            actionTag = 'Update';
            actionCls = 'chip-blue';
          } else {
            skipCnt++;
            actionTag = 'Skip Dup';
            actionCls = 'chip-amber';
          }
        } else {
          newCnt++;
        }
      }

      if (previewRows.length < 60) {
        previewRows.push({ r, effectiveStatus, actionTag, actionCls });
      }
    });

    $('csv-detected-format').textContent = ui.pendingCSVFormat || 'Sheet Ready';
    $('csv-preview-summary').textContent = `+${newCnt} new • ${updCnt} update • ${skipCnt} skipped (${ui.pendingCSVRows.length} rows)`;

    const extraNote =
      ui.pendingCSVRows.length > 60
        ? `<tr><td colspan="7" style="text-align:center; font-size:12px; color:var(--text-muted); padding:12px;">Showing first 60 of ${ui.pendingCSVRows.length} rows — click Import Sheet to process all.</td></tr>`
        : '';

    $('csv-preview-tbody').innerHTML =
      previewRows
        .map(
          ({ r, effectiveStatus, actionTag, actionCls }) => `
        <tr>
          <td><span class="chip ${actionCls}">${esc(actionTag)}</span></td>
          <td>
            <div class="mono" style="font-weight:600; font-size:12.5px;">${esc(r.trackingNumber)}</div>
            <div style="font-size:11px; color:var(--text-muted);">${esc(r.orderId || '—')}</div>
          </td>
          <td><span class="chip ${r.courier === 'Trax' ? 'chip-blue' : 'chip-amber'}">${esc(r.courier)}</span></td>
          <td>
            <div style="font-size:12.5px; max-width:170px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(r.customerName || '—')}</div>
            <div style="font-size:11px; color:var(--text-muted);">${esc(r.destinationCity || '')}</div>
          </td>
          <td><span class="chip chip-neutral">${esc(effectiveStatus)}</span></td>
          <td class="mono" style="font-size:12px;">${r.codAmount ? 'Rs. ' + Number(r.codAmount).toLocaleString() : '—'}</td>
          <td class="mono" style="font-size:12px;">${esc(r.dispatchDate)}</td>
        </tr>
      `
        )
        .join('') + extraNote;

    $('csv-preview-panel').style.display = 'block';
  }

  // =========================================================================
  // Quick Gate Intake
  // =========================================================================
  function updateGateInputFeedback() {
    const raw = $('inp-gate-cn').value;
    const cn = App.Couriers.normalizeTracking(raw);
    const shell = $('gate-awb-shell');
    const chip = $('gate-status-chip');
    const sel = $('inp-gate-courier');

    const existing = cn.length >= 5 ? App.Storage.findByTracking(cn) : null;

    if (ui.gateMode === 'dispatch' && existing && existing.status === 'Booked / Pickup') {
      shell.classList.remove('dup-error');
      chip.className = 'chip chip-green';
      chip.textContent = 'Pending → Scan to Process';
      $('gate-detect-hint').textContent = 'Booked in Load Sheet — scan/save to move into Processing';
      if ([...sel.options].some((o) => o.value === existing.courier)) sel.value = existing.courier;
      return;
    }

    if ((ui.gateMode === 'dispatch' || ui.gateMode === 'booked') && existing) {
      shell.classList.add('dup-error');
      chip.className = 'chip chip-red';
      chip.textContent = `DUPLICATE (${existing.status})`;
      $('gate-detect-hint').textContent = `Already logged on ${App.Aging.formatDisplayDate(existing.dispatchDate)}`;
      return;
    }

    if (ui.gateMode === 'return' && existing && existing.status === 'Returned & Verified') {
      shell.classList.add('dup-error');
      chip.className = 'chip chip-red';
      chip.textContent = 'ALREADY RETURNED!';
      $('gate-detect-hint').textContent = `Scanned on ${App.Aging.formatDateTime(existing.returnedAt)}`;
      return;
    }

    shell.classList.remove('dup-error');
    const det = App.Couriers.detectCourier(cn, App.Storage.getState().customCouriers);
    if (det.confidence === 'none') {
      chip.className = 'chip chip-blue';
      chip.textContent = 'Auto';
      $('gate-detect-hint').textContent = 'Auto-detect courier';
      return;
    }

    if (!ui.gateManualCourier && det.courier && [...sel.options].some((o) => o.value === det.courier)) {
      sel.value = det.courier;
    }
    chip.className = 'chip chip-blue';
    chip.textContent = `Detected: ${sel.value}`;
    $('gate-detect-hint').textContent = det.reason;
  }

  function showGateDupBanner(title, sub, cn) {
    ui.lastDupCN = cn;
    $('gate-dup-title').textContent = title;
    $('gate-dup-sub').textContent = sub;
    $('gate-dup-banner').style.display = 'flex';
  }

  function processGateSubmit(e) {
    if (e) e.preventDefault();
    const raw = $('inp-gate-cn').value.trim();
    if (!raw) return;

    if (ui.gateMode === 'return') {
      handleReturnScan(raw, true);
      $('inp-gate-cn').value = '';
      updateGateInputFeedback();
      $('inp-gate-cn').focus();
      return;
    }

    const targetStatus = ui.gateMode === 'booked' ? 'Booked / Pickup' : 'In Transit';
    const res = App.Storage.addParcel({
      trackingNumber: raw,
      courier: $('inp-gate-courier').value,
      orderId: $('inp-gate-order').value,
      dispatchDate: $('inp-gate-date').value || App.Aging.getTodayISO(),
      customerName: $('inp-gate-customer').value,
      customerPhone: $('inp-gate-phone').value,
      status: targetStatus
    });

    if (!res.ok) {
      App.Audio.playDuplicateBuzz();
      flashScreen('flash-red');
      if (res.duplicate && res.existing) {
        const ex = res.existing;
        showGateDupBanner(
          `DOUBLE ENTRY BLOCKED (${ex.trackingNumber})`,
          `Already logged on ${App.Aging.formatDisplayDate(ex.dispatchDate)} • Status: ${ex.status} (Attempt #${res.attemptCount})`,
          ex.trackingNumber
        );
        pushIntakeEvent({
          cn: ex.trackingNumber,
          courier: ex.courier,
          sub: `Duplicate blocked (Attempt #${res.attemptCount})`,
          status: 'Duplicate',
          chipCls: 'chip-red',
          time: nowClock(),
          isDup: true
        });
      }
      toast(res.error, 'error');
      $('inp-gate-cn').select();
      renderAll();
      return;
    }

    $('gate-dup-banner').style.display = 'none';
    App.Audio.playDispatchTick();
    flashScreen('flash-green');
    const feedStatus = res.promotedFromBooked
      ? 'Processing'
      : targetStatus === 'Booked / Pickup'
      ? 'Pending'
      : 'Processing';
    const feedSub = res.promotedFromBooked
      ? `${res.parcel.customerName || res.parcel.orderId} • Load Sheet → Processing`
      : `${res.parcel.customerName || res.parcel.orderId} • ${targetStatus === 'Booked / Pickup' ? 'Pending Load' : 'Processing'}`;
    pushIntakeEvent({
      cn: res.parcel.trackingNumber,
      courier: res.parcel.courier,
      sub: feedSub,
      status: feedStatus,
      chipCls: targetStatus === 'Booked / Pickup' ? 'chip-amber' : 'chip-green',
      time: nowClock(),
      isDup: false
    });
    toast(
      res.promotedFromBooked
        ? `Moved to Processing: ${res.parcel.trackingNumber}`
        : `${targetStatus === 'Booked / Pickup' ? 'Pending' : 'Processing'}: ${res.parcel.trackingNumber}`,
      'success'
    );
    autoTrackParcelInBackground(res.parcel);

    $('inp-gate-cn').value = '';
    $('inp-gate-order').value = '';
    $('inp-gate-customer').value = '';
    $('inp-gate-phone').value = '';
    ui.gateManualCourier = false;
    ui.page = 1;
    updateGateInputFeedback();
    renderAll();
    $('inp-gate-cn').focus();
  }

  // =========================================================================
  // Return Scanner
  // =========================================================================
  function updateReturnCamUI(running, caps) {
    $('btn-start-return-cam').style.display = running ? 'none' : 'inline-flex';
    $('btn-stop-return-cam').style.display = running ? 'inline-flex' : 'none';
    $('return-camera-placeholder').style.display = running ? 'none' : 'flex';
    $('return-camera-stage').classList.toggle('active', running);

    const c = caps || App.Scanner.getCapabilities();
    $('btn-return-torch').style.display = running && c.torchSupported ? 'inline-flex' : 'none';
    $('btn-return-torch').textContent = c.torchOn ? 'Flash ON' : 'Flash';
    $('btn-return-zoom').style.display = running && c.zoomSupported ? 'inline-flex' : 'none';
    $('btn-return-zoom').textContent = `${c.currentZoom || 1}x`;
    $('scanner-engine-lbl').textContent = running
      ? c.nativeAccelerated
        ? 'FAST-SCAN • 20 FPS'
        : 'LIVE • 1080P 20 FPS'
      : 'READY • 1D OPTICAL';
  }

  function renderReturnSession() {
    $('sess-valid').textContent = ui.session.valid;
    $('sess-dup').textContent = ui.session.dup;
    $('sess-leopards').textContent = ui.session.leopards;
    $('sess-trax').textContent = ui.session.trax;
    const box = $('return-scan-stream');
    if (ui.session.log.length === 0) return;
    box.innerHTML = ui.session.log
      .map(
        (it) => `
      <div class="feed-row ${it.isDup ? 'is-dup' : ''}">
        <div style="min-width:0;">
          <div class="mono" style="font-weight:600;">${esc(it.cn)}</div>
          <div style="font-size:11.5px; color:${it.isDup ? 'var(--red-text)' : 'var(--text-muted)'};">${esc(it.detail)}</div>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <span class="chip ${it.chipCls}">${esc(it.tag)}</span>
          <div class="mono" style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">${esc(it.time)}</div>
        </div>
      </div>
    `
      )
      .join('');
  }

  function handleReturnScan(rawCode, fromOverviewGate) {
    const res = App.Storage.processReturnScan(rawCode);
    if (res.outcome === 'empty') return;
    const t = nowClock();
    const fbCard = $('scan-feedback-card');

    if (res.outcome === 'valid') {
      const p = res.parcel;
      App.Audio.playSuccess();
      flashScreen('flash-green');
      $('gate-dup-banner').style.display = 'none';
      ui.session.valid++;
      if (p.courier.toLowerCase().includes('leopard')) ui.session.leopards++;
      if (p.courier.toLowerCase().includes('trax')) ui.session.trax++;

      fbCard.className = 'scan-feedback-card valid';
      $('scan-fb-title').textContent = `VALID RETURN — ${p.trackingNumber}`;
      $('scan-fb-sub').textContent = `${p.courier} • ${p.orderId || 'N/A'} • Verified at ${App.Aging.formatDateTime(p.returnedAt)}`;

      ui.session.log.unshift({ cn: p.trackingNumber, detail: `${p.courier} • Verified Return`, tag: 'OK', chipCls: 'chip-green', time: t, isDup: false });
      pushIntakeEvent({ cn: p.trackingNumber, courier: p.courier, sub: `Physical return verified`, status: 'Returned', chipCls: 'chip-purple', time: t, isDup: false });
      if (fromOverviewGate) toast(`Return Verified: ${p.trackingNumber}`, 'success');
      renderReturnSession();
      renderAll();
    } else if (res.outcome === 'duplicate') {
      const p = res.parcel;
      const when = App.Aging.formatDateTime(p.returnedAt);
      App.Audio.playDuplicateBuzz();
      flashScreen('flash-red');
      ui.session.dup++;

      fbCard.className = 'scan-feedback-card duplicate';
      $('scan-fb-title').textContent = `ALREADY SCANNED on ${when} (Attempt #${res.attemptCount || 2})`;
      $('scan-fb-sub').textContent = `DUPLICATE RETURN BLOCKED: ${p.trackingNumber} (${p.courier})`;

      if (fromOverviewGate) {
        showGateDupBanner(`DUPLICATE RETURN SCAN (${p.trackingNumber})`, `ALREADY SCANNED on ${when} (Attempt #${res.attemptCount || 2})`, p.trackingNumber);
      }
      ui.session.log.unshift({ cn: p.trackingNumber, detail: `Duplicate! Already scanned ${when}`, tag: 'DUPLICATE', chipCls: 'chip-red', time: t, isDup: true });
      pushIntakeEvent({ cn: p.trackingNumber, courier: p.courier, sub: `Already scanned on ${when}`, status: 'Duplicate', chipCls: 'chip-red', time: t, isDup: true });
      toast(`ALREADY SCANNED on ${when}`, 'error');
      renderReturnSession();
      renderAll();
    } else if (res.outcome === 'unknown') {
      App.Audio.playUnknownChime();
      flashScreen('flash-yellow');
      fbCard.className = 'scan-feedback-card unknown';
      $('scan-fb-title').textContent = `UNKNOWN PARCEL — ${res.trackingNumber}`;
      $('scan-fb-sub').textContent = 'Not found in ledger. Confirm popup to log as unrecorded return.';

      ui.pendingUnknownCN = res.trackingNumber;
      $('unknown-tracking-display').textContent = res.trackingNumber;
      syncCourierControls();
      if (res.detectedCourier) $('inp-unknown-courier').value = res.detectedCourier;
      $('inp-unknown-order').value = '';
      $('modal-unknown-parcel').classList.add('open');
    }
  }

  function handleDispatchScan(rawCode) {
    const res = App.Storage.processDispatchScan(rawCode);
    if (res.outcome === 'empty') return;
    const t = nowClock();
    const fbCard = $('scan-feedback-card');

    if (res.outcome === 'valid') {
      const p = res.parcel;
      App.Audio.playDispatchTick();
      flashScreen('flash-green');
      ui.session.valid++;
      if (p.courier.toLowerCase().includes('leopard')) ui.session.leopards++;
      if (p.courier.toLowerCase().includes('trax')) ui.session.trax++;

      fbCard.className = 'scan-feedback-card valid';
      $('scan-fb-title').textContent = `PROCESSING — ${p.trackingNumber}`;
      $('scan-fb-sub').textContent = `Load Sheet → Processing • ${p.courier} • ${p.orderId || 'N/A'}`;

      ui.session.log.unshift({ cn: p.trackingNumber, detail: `${p.courier} • Load → Processing`, tag: 'PROCESSING', chipCls: 'chip-green', time: t, isDup: false });
      pushIntakeEvent({ cn: p.trackingNumber, courier: p.courier, sub: 'Load Sheet → Processing', status: 'Processing', chipCls: 'chip-green', time: t, isDup: false });
      renderReturnSession();
      renderAll();
      autoTrackParcelInBackground(p);
    } else if (res.outcome === 'duplicate') {
      const p = res.parcel;
      App.Audio.playDuplicateBuzz();
      flashScreen('flash-red');
      ui.session.dup++;

      fbCard.className = 'scan-feedback-card duplicate';
      $('scan-fb-title').textContent = `ALREADY ${String(p.status || 'DISPATCHED').toUpperCase()} — ${p.trackingNumber}`;
      $('scan-fb-sub').textContent = `Duplicate dispatch scan blocked (${p.courier})`;

      ui.session.log.unshift({ cn: p.trackingNumber, detail: `Already ${p.status}`, tag: 'DUPLICATE', chipCls: 'chip-red', time: t, isDup: true });
      toast(`Already ${p.status}: ${p.trackingNumber}`, 'error');
      renderReturnSession();
      renderAll();
    } else if (res.outcome === 'unknown') {
      App.Audio.playUnknownChime();
      flashScreen('flash-yellow');
      fbCard.className = 'scan-feedback-card unknown';
      $('scan-fb-title').textContent = `NOT IN LOAD SHEET — ${res.trackingNumber}`;
      $('scan-fb-sub').textContent = 'Upload Load Sheet first or add via Orders → New Order.';
      toast(`Not in Load Sheet: ${res.trackingNumber}`, 'warning');
    }
  }

  function handleScannerCapture(rawCode) {
    if (ui.scannerMode === 'dispatch') handleDispatchScan(rawCode);
    else handleReturnScan(rawCode, false);
  }

  function autoTrackParcelInBackground(parcel) {
    if (!parcel || !App.TrackingAPI || !App.TrackingAPI.hasLiveCredentials(parcel.courier)) return;
    App.TrackingAPI.trackParcel(parcel.trackingNumber, parcel.courier, parcel)
      .then((r) => {
        if (r && r.ok) renderAll();
      })
      .catch(() => {});
  }

  // =========================================================================
  // Slide-Over Live Tracking & Inspection Drawer
  // =========================================================================
  function renderTimeline(checkpoints) {
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
      return `<div style="font-size:12px; color:var(--text-muted);">No live checkpoints available yet.</div>`;
    }
    return checkpoints
      .map(
        (cp) => `
      <div class="timeline-step">
        <span class="timeline-dot"></span>
        <div style="display:flex; justify-content:space-between; gap:8px;">
          <strong style="font-size:12.5px;">${esc(cp.status)}</strong>
          <span class="mono" style="font-size:11px; color:var(--text-muted); flex-shrink:0;">${esc(cp.timestamp || '')}</span>
        </div>
        <div style="font-size:11.5px; color:var(--text-secondary); margin-top:2px;">${esc(cp.location || '')}${cp.detail ? ' — ' + esc(cp.detail) : ''}</div>
      </div>
    `
      )
      .join('');
  }

  async function openTrackingDrawer(rawCN, courierHint) {
    const cn = App.Couriers.normalizeTracking(rawCN);
    if (!cn) return;
    const p = App.Storage.findByTracking(cn);
    const courier =
      courierHint ||
      (p && p.courier) ||
      App.Couriers.detectCourier(cn, App.Storage.getState().customCouriers).courier ||
      'Trax';

    ui.activeDrawerCN = cn;
    ui.activeDrawerCourier = courier;

    $('drawer-cn').textContent = cn;
    $('drawer-courier-chip').textContent = courier;
    $('drawer-route-tag').textContent = p && p.destinationCity ? `Faisalabad → ${p.destinationCity}` : 'Syncing...';
    $('drawer-client-name').textContent = (p && p.customerName) || 'Fetching live details...';
    $('drawer-client-sub').textContent = p
      ? [p.orderId, p.customerPhone, p.address || p.destinationCity].filter(Boolean).join(' • ')
      : 'External CN lookup';

    // Show local contact buttons + sheet COD/Status pills immediately!
    const localDigits = String((p && p.customerPhone) || '').replace(/[^\d]/g, '');
    if (localDigits) {
      const wa = localDigits.startsWith('0') ? '92' + localDigits.slice(1) : localDigits;
      $('drawer-contact-btns').innerHTML = `
        <a href="tel:${esc(localDigits)}" class="btn btn-sm">Call</a>
        <a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-primary">WhatsApp</a>
      `;
    } else {
      $('drawer-contact-btns').innerHTML = '';
    }

    const initPills = [];
    if (p && p.codAmount) initPills.push(`<span class="chip chip-blue">COD Rs. ${Number(p.codAmount).toLocaleString()}</span>`);
    if (p && p.courierStatus) initPills.push(`<span class="chip chip-neutral">${esc(p.courierStatus)}</span>`);
    if (initPills.length) {
      $('drawer-fin-strip').style.display = 'flex';
      $('drawer-fin-strip').innerHTML = initPills.join('');
    } else {
      $('drawer-fin-strip').style.display = 'none';
    }

    $('drawer-error-banner').style.display = 'none';
    $('drawer-trax-actions').style.display = 'none';
    $('drawer-timeline').innerHTML = `<div style="font-size:12px; color:var(--text-muted);">Querying ${esc(courier)} Live API...</div>`;
    $('drawer-official-link').href = App.TrackingAPI.getOfficialPortalUrl(courier, cn);

    const canAct = Boolean(p && ['Booked / Pickup', 'In Transit', 'Return In Transit'].includes(p.status));
    $('btn-drawer-deliver').style.display = canAct ? 'inline-flex' : 'none';
    $('btn-drawer-return').style.display = canAct ? 'inline-flex' : 'none';

    $('tracking-drawer').classList.add('open');

    const res = await App.TrackingAPI.trackParcel(cn, courier, p);

    if (!res.ok) {
      $('drawer-route-tag').textContent = (p && p.destinationCity) ? `→ ${p.destinationCity}` : res.missingCredentials ? 'API Key Needed' : 'API Notice';
      $('drawer-error-banner').style.display = 'flex';
      $('drawer-error-banner').innerHTML = `
        <span>${esc(res.error)}</span>
        <button type="button" class="btn btn-sm btn-primary" id="btn-drawer-api-setup">Settings</button>
      `;
      const btn = $('btn-drawer-api-setup');
      if (btn) btn.addEventListener('click', () => { closeDrawer(); switchView('settings'); });

      if (p && p.liveSource === 'live' && Array.isArray(p.trackingHistory) && p.trackingHistory.length) {
        $('drawer-timeline').innerHTML = renderTimeline(p.trackingHistory);
      } else {
        $('drawer-timeline').innerHTML = `<div style="font-size:12px; color:var(--text-muted);">Sheet Status: <strong>${esc((p && (p.courierStatus || p.status)) || 'Saved locally')}</strong></div>`;
      }
      return;
    }

    const d = res.data;
    $('drawer-route-tag').textContent = `${d.origin} → ${d.destination}`;
    $('drawer-client-name').textContent = d.consignee || (p && p.customerName) || 'Consignee';
    $('drawer-client-sub').textContent = [d.orderId || (p && p.orderId), d.consigneePhone || (p && p.customerPhone), d.consigneeAddress || (p && p.address)].filter(Boolean).join(' • ');

    const digits = String(d.consigneePhone || (p && p.customerPhone) || '').replace(/[^\d]/g, '');
    if (digits) {
      const wa = digits.startsWith('0') ? '92' + digits.slice(1) : digits;
      $('drawer-contact-btns').innerHTML = `
        <a href="tel:${esc(digits)}" class="btn btn-sm">Call</a>
        <a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-primary">WhatsApp</a>
      `;
    }

    const pills = [];
    if (d.codAmount) pills.push(`<span class="chip chip-blue">${esc(d.codAmount)}</span>`);
    else if (p && p.codAmount) pills.push(`<span class="chip chip-blue">COD Rs. ${Number(p.codAmount).toLocaleString()}</span>`);
    if (d.shippingMode) pills.push(`<span class="chip chip-neutral">${esc(d.shippingMode)}</span>`);
    if (d.paymentStatus) pills.push(`<span class="chip chip-green">${esc(d.paymentStatus)}</span>`);
    if (d.charges && d.charges.total_charges) pills.push(`<span class="chip chip-neutral">Charges: Rs. ${esc(d.charges.total_charges)}</span>`);
    if (pills.length) {
      $('drawer-fin-strip').style.display = 'flex';
      $('drawer-fin-strip').innerHTML = pills.join('');
    }

    if (d.courier.toLowerCase().includes('trax') && App.TrackingAPI.hasLiveCredentials('Trax')) {
      $('drawer-trax-actions').style.display = 'block';
    }

    $('drawer-timeline').innerHTML = renderTimeline(d.checkpoints);
    renderAll();
  }

  function closeDrawer() {
    $('tracking-drawer').classList.remove('open');
  }

  async function runBulkLiveSync() {
    if (ui.isSyncing) return;
    ui.isSyncing = true;
    $('topbar-sync-icon').classList.add('spin');
    $('topbar-sync-label').textContent = 'Syncing';

    let cloudMsg = '';
    if (App.CloudSync) {
      const sc = App.CloudSync.loadConfig();
      if (sc.enabled && sc.endpointUrl) {
        const cRes = await App.CloudSync.syncWithCloud('manual');
        cloudMsg = cRes.ok ? `Cloud synced (${cRes.count})` : `Cloud error: ${cRes.error}`;
      } else if (App.CloudSync.hasLocalDiskBackend()) {
        await App.CloudSync.saveToLocalDisk();
      }
    }

    const res = await App.TrackingAPI.syncAllInTransit();
    ui.isSyncing = false;
    $('topbar-sync-icon').classList.remove('spin');
    renderAll();

    if (res.corsError) toast('Launch MM-VIRSA-Ops.exe for zero-CORS live sync!', 'error');
    else if (res.synced > 0) toast(`Live Synced ${res.synced}/${res.total} shipments${cloudMsg ? ' • ' + cloudMsg : ''}`, 'success');
    else if (cloudMsg) toast(cloudMsg, cloudMsg.includes('error') ? 'error' : 'success');
    else if (res.total === 0) toast('Synced cleanly.', 'success');
    else if (res.skippedNoKey > 0) {
      toast('Add your Trax / Leopards API Key in Settings to live-track couriers.', 'warning');
      switchView('settings');
    } else toast(res.lastError || 'Sync completed.', 'error');
  }

  // =========================================================================
  // Admin PIN Guard & Edit Modal
  // =========================================================================
  function requireAdminPin(label, fn) {
    if (!App.Security || !App.Security.needsAdminVerification()) return fn();
    ui.pendingAdminAction = fn;
    $('admin-pin-prompt-text').textContent = `Enter Admin PIN to confirm: ${label}`;
    $('admin-pin-error').textContent = '';
    $('inp-admin-verify-pin').value = '';
    $('modal-admin-pin').classList.add('open');
    setTimeout(() => $('inp-admin-verify-pin').focus(), 50);
  }

  function openEditModal(id) {
    const p = App.Storage.findById(id);
    if (!p) return;
    syncCourierControls();
    $('edit-parcel-id').value = p.id;
    $('edit-tracking').value = p.trackingNumber;
    $('edit-order-id').value = p.orderId || '';
    $('edit-courier').value = p.courier;
    $('edit-dispatch-date').value = p.dispatchDate;
    $('edit-status').value = p.status;
    $('edit-customer-name').value = p.customerName || '';
    $('edit-customer-phone').value = p.customerPhone || '';
    $('edit-cod-amount').value = p.codAmount || '';
    $('edit-notes').value = p.notes || '';
    $('modal-edit-parcel').classList.add('open');
  }

  // =========================================================================
  // Event Binding
  // =========================================================================
  function bindEvents() {
    document.querySelectorAll('[data-nav]').forEach((b) =>
      b.addEventListener('click', () => switchView(b.getAttribute('data-nav')))
    );
    document.querySelectorAll('[data-nav-jump]').forEach((b) =>
      b.addEventListener('click', () => switchView(b.getAttribute('data-nav-jump')))
    );
    document.querySelectorAll('[data-jump-status]').forEach((b) =>
      b.addEventListener('click', () => {
        const st = b.getAttribute('data-jump-status');
        switchView('overview');
        setStatusTab(st);
      })
    );
    $('btn-dash-new-order').addEventListener('click', () => {
      switchView('overview');
      setGateDrawerOpen(true, true);
    });

    // Smooth Topbar Refresh
    $('btn-topbar-refresh').addEventListener('click', async () => {
      const btn = $('btn-topbar-refresh');
      const bar = $('refresh-progress-bar');
      const main = document.querySelector('.main-content');
      if (btn.classList.contains('is-refreshing')) return;

      btn.classList.add('is-refreshing');
      if (bar) bar.classList.add('active');
      if (main) {
        main.classList.remove('is-refreshing');
        void main.offsetWidth;
        main.classList.add('is-refreshing');
      }

      const startTs = Date.now();
      try {
        if (App.CloudSync) {
          if (App.CloudSync.hasLocalDiskBackend()) await App.CloudSync.loadFromLocalDisk();
          const sc = App.CloudSync.loadConfig();
          if (sc.enabled && sc.endpointUrl) await App.CloudSync.syncWithCloud('refresh');
        }
        App.Storage.load();
        renderAll();
      } catch (_) {}

      const wait = Math.max(0, 620 - (Date.now() - startTs));
      setTimeout(() => {
        btn.classList.remove('is-refreshing');
        if (bar) bar.classList.remove('active');
        toast('Refreshed', 'success');
      }, wait);
    });

    $('btn-topbar-sync').addEventListener('click', runBulkLiveSync);

    // Bell Dropdown
    $('btn-notif-bell').addEventListener('click', (e) => {
      e.stopPropagation();
      $('notif-dropdown').classList.toggle('open');
    });
    $('btn-close-notif').addEventListener('click', () => $('notif-dropdown').classList.remove('open'));
    $('btn-goto-alerts-bell').addEventListener('click', () => switchView('alerts'));
    document.addEventListener('click', (e) => {
      const dd = $('notif-dropdown');
      if (dd.classList.contains('open') && !dd.contains(e.target) && !e.target.closest('#btn-notif-bell')) {
        dd.classList.remove('open');
      }
    });

    // Demo strip
    $('btn-dismiss-demo').addEventListener('click', () => { App.Storage.dismissSampleFlag(); renderAll(); });
    $('btn-clear-demo').addEventListener('click', () => { App.Storage.clearAllData(); renderAll(); toast('Cleared sample data.'); });

    // Orders KPI & Underline Tabs
    document.querySelectorAll('[data-kpi-filter]').forEach((c) =>
      c.addEventListener('click', () => setStatusTab(c.getAttribute('data-kpi-filter')))
    );
    $('status-underline-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-status-tab]');
      if (!tab) return;
      setStatusTab(tab.getAttribute('data-status-tab'));
    });

    // Pagination
    $('pagination-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      const next = parseInt(btn.getAttribute('data-page'), 10);
      if (!isNaN(next) && next >= 1) {
        ui.page = next;
        renderLedger(App.Storage.getParcels());
        global.scrollTo({ top: 180, behavior: 'smooth' });
      }
    });

    // Quick Gate Drawer Toggle
    $('btn-toggle-gate').addEventListener('click', () => setGateDrawerOpen(!ui.gateOpen, true));
    $('btn-close-gate-box').addEventListener('click', () => setGateDrawerOpen(false, false));

    document.querySelectorAll('[data-gate-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        ui.gateMode = b.getAttribute('data-gate-mode');
        document.querySelectorAll('[data-gate-mode]').forEach((x) => x.classList.toggle('active', x === b));
        $('gate-submit-label').textContent = ui.gateMode === 'return' ? 'Verify' : ui.gateMode === 'booked' ? 'Book' : 'Save';
        $('inp-gate-cn').placeholder =
          ui.gateMode === 'return' ? 'Scan Return CN...' : ui.gateMode === 'booked' ? 'Scan Booked / Load CN...' : 'Scan or type Tracking CN...';
        updateGateInputFeedback();
        $('inp-gate-cn').focus();
      })
    );

    $('inp-gate-date').value = App.Aging.getTodayISO();
    $('inp-gate-cn').addEventListener('input', () => {
      if (!$('inp-gate-cn').value.trim()) ui.gateManualCourier = false;
      updateGateInputFeedback();
    });
    $('inp-gate-courier').addEventListener('change', () => {
      ui.gateManualCourier = true;
      updateGateInputFeedback();
    });
    $('btn-toggle-extra-fields').addEventListener('click', () => {
      const el = $('gate-extra-fields');
      const open = el.style.display === 'none';
      el.style.display = open ? 'block' : 'none';
      $('btn-toggle-extra-fields').textContent = open ? '− Details' : '+ Details';
    });
    $('gate-form').addEventListener('submit', processGateSubmit);
    $('btn-gate-dup-close').addEventListener('click', () => ($('gate-dup-banner').style.display = 'none'));
    $('btn-gate-dup-inspect').addEventListener('click', () => { if (ui.lastDupCN) openTrackingDrawer(ui.lastDupCN); });

    // Gate Camera Modal
    $('btn-gate-camera').addEventListener('click', async () => {
      $('gate-camera-error').textContent = '';
      $('modal-gate-camera').classList.add('open');
      await App.Scanner.start(
        'gate-camera-reader',
        async (code) => {
          await App.Scanner.stop();
          $('modal-gate-camera').classList.remove('open');
          $('inp-gate-cn').value = code;
          ui.gateManualCourier = false;
          updateGateInputFeedback();
          processGateSubmit();
        },
        (err) => ($('gate-camera-error').textContent = err),
        { cooldownMs: 1200 }
      );
    });
    $('btn-close-gate-camera').addEventListener('click', async () => {
      await App.Scanner.stop();
      $('modal-gate-camera').classList.remove('open');
    });

    // Orders Search, Courier Filter & Export
    $('filter-search').addEventListener('input', () => {
      ui.page = 1;
      renderLedger(App.Storage.getParcels());
    });
    $('filter-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = $('filter-search').value.trim();
        if (q.length >= 6) {
          e.preventDefault();
          openTrackingDrawer(q);
        }
      }
    });
    $('filter-courier').addEventListener('change', () => {
      ui.page = 1;
      renderLedger(App.Storage.getParcels());
    });
    $('btn-top-export-all').addEventListener('click', () => {
      const list = getFilteredParcels(App.Storage.getParcels());
      const res = App.CSV.exportReportCSV(list.length ? list : App.Storage.getParcels(), {
        courier: $('filter-courier').value || 'All',
        reportType: 'orders_export'
      });
      toast(res.ok ? `Exported ${res.count} orders` : 'No orders to export.', res.ok ? 'success' : 'warning');
    });

    // Delegated Actions
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const act = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      if (act === 'track') {
        openTrackingDrawer(btn.getAttribute('data-cn'), btn.getAttribute('data-courier'));
      } else if (act === 'deliver' && id) {
        const p = App.Storage.updateParcelStatus(id, 'Delivered');
        if (p) { App.Audio.playDispatchTick(); toast(`Delivered: ${p.trackingNumber}`); renderAll(); }
      } else if (act === 'verify-return' && id) {
        const p = App.Storage.updateParcelStatus(id, 'Returned & Verified');
        if (p) { App.Audio.playSuccess(); toast(`Return Verified: ${p.trackingNumber}`); renderAll(); }
      } else if (act === 'edit' && id) {
        openEditModal(id);
      }
    });

    // Dedicated CSV & Excel Sheet Uploader
    $('upload-mode-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sheet-mode]');
      if (!btn) return;
      ui.sheetMode = btn.getAttribute('data-sheet-mode');
      $('upload-mode-tabs').querySelectorAll('[data-sheet-mode]').forEach((x) => x.classList.toggle('active', x === btn));
      $('upload-mode-hint').textContent = SHEET_MODE_HINTS[ui.sheetMode] || SHEET_MODE_HINTS.auto;
      if (ui.pendingCSVRows.length) renderCSVPreview();
    });

    const dz = $('csv-dropzone');
    const fi = $('csv-file-input');
    const handleSheetFile = async (file) => {
      if (!file) return;
      toast(`Reading ${file.name}...`, 'success');
      const parsed = await App.CSV.parseSpreadsheetFile(file, App.Storage.getState().customCouriers);
      if (parsed.error) return toast(parsed.error, 'error');
      ui.pendingCSVRows = parsed.rows;
      ui.pendingCSVFormat = parsed.format || 'Courier Sheet';
      $('upload-format-badge').textContent = ui.pendingCSVFormat;
      renderCSVPreview();
    };

    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('dragover'); handleSheetFile(e.dataTransfer.files[0]); });
    fi.addEventListener('change', () => { handleSheetFile(fi.files[0]); fi.value = ''; });
    $('chk-csv-update-existing').addEventListener('change', () => { if (ui.pendingCSVRows.length) renderCSVPreview(); });
    $('chk-csv-skip-cancelled').addEventListener('change', () => { if (ui.pendingCSVRows.length) renderCSVPreview(); });
    $('btn-sample-trax').addEventListener('click', () => App.CSV.downloadTraxSampleCSV());
    $('btn-sample-leopards').addEventListener('click', () => App.CSV.downloadLeopardsSampleCSV());
    $('btn-cancel-csv').addEventListener('click', () => {
      ui.pendingCSVRows = [];
      ui.pendingCSVFormat = '';
      $('csv-preview-panel').style.display = 'none';
      $('upload-format-badge').textContent = 'CSV • XLSX • XLS';
    });
    $('btn-confirm-csv-import').addEventListener('click', () => {
      const r = App.Storage.bulkAddParcels(ui.pendingCSVRows, {
        sheetMode: ui.sheetMode,
        updateExisting: $('chk-csv-update-existing').checked,
        skipCancelled: $('chk-csv-skip-cancelled').checked
      });
      ui.pendingCSVRows = [];
      ui.pendingCSVFormat = '';
      $('csv-preview-panel').style.display = 'none';
      $('upload-format-badge').textContent = 'CSV • XLSX • XLS';
      App.Audio.playSuccess();
      renderAll();
      toast(`Sheet imported: +${r.added.length} new, ${r.updated.length} updated, ${r.skipped.length} skipped`, 'success');
    });

    // Return / Dispatch Scanner Controls
    if ($('scanner-mode-tabs')) {
      $('scanner-mode-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-scanner-mode]');
        if (!b) return;
        ui.scannerMode = b.getAttribute('data-scanner-mode');
        $('scanner-mode-tabs').querySelectorAll('[data-scanner-mode]').forEach((x) => x.classList.toggle('active', x === b));
        const fbCard = $('scan-feedback-card');
        fbCard.className = 'scan-feedback-card';
        if (ui.scannerMode === 'dispatch') {
          $('scan-fb-title').textContent = 'Dispatch Scan (Load Sheet → Processing)';
          $('scan-fb-sub').textContent = 'Scan Pending load-sheet parcels to move them into Processing';
        } else {
          $('scan-fb-title').textContent = 'Ready to scan returns';
          $('scan-fb-sub').textContent = 'Start camera or use USB barcode gun';
        }
        $('inp-return-scan').focus();
      });
    }

    $('return-scan-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = $('inp-return-scan');
      const v = inp.value.trim();
      inp.value = '';
      if (v) handleScannerCapture(v);
      inp.focus();
    });
    $('btn-toggle-sound').addEventListener('click', () => {
      const next = !App.Audio.isMuted();
      App.Audio.setMuted(next);
      $('btn-toggle-sound').textContent = next ? 'Sound: OFF' : 'Sound: ON';
    });
    $('btn-start-return-cam').addEventListener('click', async () => {
      $('return-camera-error').style.display = 'none';
      App.Scanner.resetCameraCooldown();
      updateReturnCamUI(true);
      const r = await App.Scanner.start(
        'return-camera-reader',
        (code) => handleScannerCapture(code),
        (err) => {
          updateReturnCamUI(false);
          $('return-camera-error').textContent = err;
          $('return-camera-error').style.display = 'block';
        },
        { cooldownMs: 1500 }
      );
      if (!r.ok) updateReturnCamUI(false);
      else updateReturnCamUI(true, r.capabilities);
    });
    $('btn-stop-return-cam').addEventListener('click', async () => { await App.Scanner.stop(); updateReturnCamUI(false); });
    $('btn-return-torch').addEventListener('click', async () => {
      const r = await App.Scanner.toggleTorch();
      $('btn-return-torch').textContent = r.torchOn ? 'Flash ON' : 'Flash';
    });
    $('btn-return-zoom').addEventListener('click', async () => {
      const r = await App.Scanner.cycleZoom();
      $('btn-return-zoom').textContent = `${r.currentZoom}x`;
    });

    // Global USB Barcode Gun Wedge
    App.Scanner.attachUsbWedge((code) => {
      if (App.Security && App.Security.isLocked()) return;
      if (ui.activeView === 'returns') {
        handleScannerCapture(code);
      } else if (ui.activeView === 'overview' || ui.activeView === 'dashboard') {
        if (ui.activeView === 'dashboard') switchView('overview');
        if (!ui.gateOpen) setGateDrawerOpen(true, false);
        $('inp-gate-cn').value = code;
        ui.gateManualCourier = false;
        updateGateInputFeedback();
        processGateSubmit();
      }
    });

    // Alerts Tabs & Courier Filter
    document.querySelectorAll('[data-alert-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        ui.alertTab = b.getAttribute('data-alert-tab');
        document.querySelectorAll('[data-alert-tab]').forEach((x) => x.classList.toggle('active', x === b));
        renderAlertsView(App.Aging.summarize(App.Storage.getParcels()));
      })
    );
    $('alerts-courier-pills').addEventListener('click', (e) => {
      const b = e.target.closest('[data-alert-courier]');
      if (!b) return;
      ui.alertCourier = b.getAttribute('data-alert-courier');
      syncCourierControls();
      renderAlertsView(App.Aging.summarize(App.Storage.getParcels()));
    });

    // Complaint & Report CSV Export Buttons
    document.querySelectorAll('[data-export-complaint]').forEach((b) =>
      b.addEventListener('click', () => {
        const c = b.getAttribute('data-export-complaint');
        const r = App.CSV.exportReportCSV(App.Storage.getParcels(), { courier: c, reportType: 'complaint_all' });
        toast(r.ok ? `Exported ${c} complaint list (${r.count})` : `No 5+ day overdue parcels for ${c}.`, r.ok ? 'success' : 'warning');
      })
    );
    document.querySelectorAll('[data-export-returns-today]').forEach((b) =>
      b.addEventListener('click', () => {
        const c = b.getAttribute('data-export-returns-today');
        const r = App.CSV.exportReportCSV(App.Storage.getParcels(), { courier: c, reportType: 'returns_today' });
        toast(r.ok ? `Exported ${r.count} ${c} returns today` : `No ${c} returns scanned today.`, r.ok ? 'success' : 'warning');
      })
    );
    document.querySelectorAll('[data-report-courier]').forEach((b) =>
      b.addEventListener('click', () => {
        const r = App.CSV.exportReportCSV(App.Storage.getParcels(), {
          courier: b.getAttribute('data-report-courier'),
          reportType: b.getAttribute('data-report-type')
        });
        toast(r.ok ? `Exported ${r.count} rows` : 'No matching rows for this report.', r.ok ? 'success' : 'warning');
      })
    );

    // Custom Couriers
    $('add-courier-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const r = App.Storage.addCustomCourier($('inp-new-courier-name').value, $('inp-new-courier-prefixes').value);
      if (!r.ok) return toast(r.error, 'error');
      $('inp-new-courier-name').value = '';
      $('inp-new-courier-prefixes').value = '';
      renderAll();
      toast('Courier added.');
    });
    $('courier-list-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove-courier]');
      if (!b) return;
      App.Storage.removeCustomCourier(b.getAttribute('data-remove-courier'));
      renderAll();
    });

    // Backups & Restore
    $('btn-export-json').addEventListener('click', () => {
      App.CSV.triggerDownload(`virsa_backup_${App.Aging.getTodayISO()}.json`, App.Storage.exportBackupJSON(), 'application/json');
      toast('JSON backup downloaded.');
    });
    $('btn-export-encrypted').addEventListener('click', async () => {
      if (!App.Security.isCryptoAvailable()) return toast('AES-256 requires MM-VIRSA-Ops.exe (localhost) or HTTPS.', 'warning');
      const pass = global.prompt('Set encryption password (min 6 chars):');
      if (!pass) return;
      try {
        const enc = await App.Security.encryptBackup(App.Storage.exportBackupJSON(), pass);
        App.CSV.triggerDownload(`virsa_aes_backup_${App.Aging.getTodayISO()}.json`, enc, 'application/json');
        toast('AES-256 encrypted backup downloaded.');
      } catch (err) { toast(err.message, 'error'); }
    });
    $('btn-restore-merge').addEventListener('click', () => $('json-restore-input').click());
    $('json-restore-input').addEventListener('change', () => {
      const f = $('json-restore-input').files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const r = App.Storage.importBackupJSON(rd.result, 'merge');
          renderAll();
          toast(`Restored ${r.addedCount} parcels (${r.skippedCount} skipped).`);
        } catch (err) { toast(err.message, 'error'); }
      };
      rd.readAsText(f);
      $('json-restore-input').value = '';
    });
    $('btn-restore-encrypted').addEventListener('click', () => $('enc-restore-input').click());
    $('enc-restore-input').addEventListener('change', () => {
      const f = $('enc-restore-input').files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = async () => {
        const pass = global.prompt('Enter decryption password:');
        if (!pass) return;
        try {
          const plain = await App.Security.decryptBackup(rd.result, pass);
          const r = App.Storage.importBackupJSON(plain, 'merge');
          renderAll();
          toast(`Decrypted & restored ${r.addedCount} parcels.`);
        } catch (err) { toast(err.message, 'error'); }
      };
      rd.readAsText(f);
      $('enc-restore-input').value = '';
    });
    $('btn-load-sample').addEventListener('click', () => {
      if (global.confirm('Load 12 sample parcels?')) { App.Storage.resetToSampleData(); renderAll(); }
    });
    $('btn-clear-all-data').addEventListener('click', () => {
      requireAdminPin('Delete all stored parcels', () => {
        if (global.confirm('Delete ALL stored parcels permanently?')) { App.Storage.clearAllData(); renderAll(); toast('All data cleared.', 'warning'); }
      });
    });

    // Live API & Cloud Sync Forms
    $('api-config-form').addEventListener('submit', (e) => {
      e.preventDefault();
      App.TrackingAPI.saveConfig({
        traxApiKey: $('inp-trax-key').value.trim(),
        traxEnv: $('inp-trax-env').value,
        corsProxyUrl: $('inp-api-proxy').value.trim(),
        leopardsApiKey: $('inp-lcs-key').value.trim(),
        leopardsApiPassword: $('inp-lcs-pass').value.trim(),
        autoMarkDeliveredOnSync: $('chk-auto-deliver').checked
      });
      hydrateSettingsForms();
      renderApiAndSecurity();
      toast('Live API keys saved.');
    });
    $('btn-test-api').addEventListener('click', () => {
      const cn = global.prompt('Enter a REAL Trax or Leopards Tracking CN to test:', '');
      if (cn && cn.trim()) openTrackingDrawer(cn.trim());
    });

    $('cloud-sync-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('inp-sync-url').value.trim();
      const enabled = $('chk-cloud-sync-enabled').checked;
      if (enabled && !url) return toast('Enter your Google Sheets Web App URL or Firebase URL first.', 'error');
      App.CloudSync.saveConfig({
        provider: $('inp-sync-provider').value,
        endpointUrl: url,
        secretToken: $('inp-sync-secret').value.trim(),
        enabled
      });
      hydrateSettingsForms();
      renderApiAndSecurity();
      toast('Sync settings saved.');
      if (enabled && url) {
        const res = await App.CloudSync.syncWithCloud('manual');
        renderAll();
        toast(res.ok ? `Cloud Sync active (${res.count} parcels)!` : `Sync failed: ${res.error}`, res.ok ? 'success' : 'error');
      }
    });

    $('btn-cloud-sync-now').addEventListener('click', async () => {
      const res = await App.CloudSync.syncWithCloud('manual');
      renderAll();
      toast(res.ok ? `Cloud synced (${res.count} parcels)` : res.error || 'Enable Cloud Sync first.', res.ok ? 'success' : 'warning');
    });

    // Drawer Controls + Direct Trax Sonic Escalation APIs
    $('btn-close-drawer').addEventListener('click', closeDrawer);
    $('tracking-drawer').addEventListener('click', (e) => { if (e.target === $('tracking-drawer')) closeDrawer(); });
    $('btn-drawer-refresh').addEventListener('click', () => openTrackingDrawer(ui.activeDrawerCN, ui.activeDrawerCourier));
    $('btn-drawer-deliver').addEventListener('click', () => {
      const p = App.Storage.findByTracking(ui.activeDrawerCN);
      if (p) { App.Storage.updateParcelStatus(p.id, 'Delivered'); toast('Marked Delivered.'); openTrackingDrawer(p.trackingNumber, p.courier); }
    });
    $('btn-drawer-return').addEventListener('click', () => {
      const p = App.Storage.findByTracking(ui.activeDrawerCN);
      if (p) { App.Storage.updateParcelStatus(p.id, 'Returned & Verified'); App.Audio.playSuccess(); toast('Return Verified.'); openTrackingDrawer(p.trackingNumber, p.courier); }
    });
    $('btn-trax-reattempt').addEventListener('click', async () => {
      const remarks = global.prompt(`Trax Re-Attempt remarks for ${ui.activeDrawerCN}:`, 'Please re-attempt delivery and call customer');
      if (remarks === null) return;
      const r = await App.TrackingAPI.sendTraxRcpRequest(ui.activeDrawerCN, 2, remarks);
      toast(r.ok ? r.message : r.error, r.ok ? 'success' : 'error');
    });
    $('btn-trax-return-confirm').addEventListener('click', async () => {
      const remarks = global.prompt(`Confirm Trax RTS Return for ${ui.activeDrawerCN}:`, 'Return confirmed by MM VIRSA');
      if (remarks === null) return;
      const r = await App.TrackingAPI.sendTraxRcpRequest(ui.activeDrawerCN, 1, remarks);
      toast(r.ok ? r.message : r.error, r.ok ? 'success' : 'error');
    });
    $('btn-trax-crm-delay').addEventListener('click', async () => {
      const desc = global.prompt(`Log Trax CRM Delay Complaint for ${ui.activeDrawerCN}:`, 'Urgent delivery delay escalation');
      if (desc === null) return;
      const r = await App.TrackingAPI.sendTraxCrmComplaint(ui.activeDrawerCN, 2, desc);
      toast(r.ok ? `${r.message} (#${r.id || ''})` : r.error, r.ok ? 'success' : 'error');
    });

    // Security PIN & Staff Name
    $('btn-lock-app').addEventListener('click', () => App.Security.lockNow());
    $('btn-sec-lock-now').addEventListener('click', () => App.Security.lockNow());
    $('lock-unlock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await App.Security.verifyPin($('inp-lock-pin').value);
      if (r.ok) { $('lock-overlay').classList.remove('open'); renderApiAndSecurity(); }
      else { App.Audio.playDuplicateBuzz(); $('lock-error-msg').textContent = r.error; $('inp-lock-pin').value = ''; }
    });
    $('btn-cancel-admin-pin').addEventListener('click', () => { $('modal-admin-pin').classList.remove('open'); ui.pendingAdminAction = null; });
    $('admin-pin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await App.Security.verifyPin($('inp-admin-verify-pin').value);
      if (r.ok) {
        const fn = ui.pendingAdminAction;
        $('modal-admin-pin').classList.remove('open');
        ui.pendingAdminAction = null;
        if (fn) fn();
      } else { App.Audio.playDuplicateBuzz(); $('admin-pin-error').textContent = r.error; }
    });
    $('security-pin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = $('inp-sec-pin').value.trim();
      const autoLock = $('inp-sec-autolock').value;
      const op = $('inp-sec-operator').value.trim();
      const cfg = App.Security.loadConfig();
      if (!pin) {
        App.Security.updateAutoLock(autoLock);
        const upd = App.Security.loadConfig();
        upd.operatorName = App.Security.sanitizeText(op, 40) || 'VIRSA Station';
        global.localStorage.setItem('virsa_ops_security_v1', JSON.stringify(upd));
        hydrateSettingsForms();
        renderApiAndSecurity();
        return toast('Staff & security settings saved.');
      }
      const saveFn = async () => {
        const r = await App.Security.setPin(pin, autoLock, op);
        if (!r.ok) return toast(r.error, 'error');
        $('inp-sec-pin').value = '';
        hydrateSettingsForms();
        renderApiAndSecurity();
        toast('Admin PIN & staff settings saved.');
      };
      if (cfg.pinEnabled) requireAdminPin('Change Admin PIN', saveFn);
      else await saveFn();
    });
    $('btn-sec-disable-pin').addEventListener('click', async () => {
      const cur = global.prompt('Enter current Admin PIN to disable:');
      if (!cur) return;
      const r = await App.Security.disablePin(cur);
      toast(r.ok ? 'PIN Lock disabled.' : r.error, r.ok ? 'warning' : 'error');
      hydrateSettingsForms();
      renderApiAndSecurity();
    });
    $('btn-export-audit').addEventListener('click', () => {
      const r = App.CSV.exportAuditLogCSV(App.Security.getAuditLog());
      toast(r.ok ? `Exported ${r.count} audit entries.` : 'Audit log is empty.', r.ok ? 'success' : 'warning');
    });

    // Unknown Parcel Modal
    const closeUnk = () => { $('modal-unknown-parcel').classList.remove('open'); ui.pendingUnknownCN = ''; };
    $('btn-cancel-unknown').addEventListener('click', closeUnk);
    $('btn-dismiss-unknown').addEventListener('click', closeUnk);
    $('unknown-parcel-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!ui.pendingUnknownCN) return closeUnk();
      const r = App.Storage.logUnrecordedReturn({
        trackingNumber: ui.pendingUnknownCN,
        courier: $('inp-unknown-courier').value,
        orderId: $('inp-unknown-order').value
      });
      closeUnk();
      if (r.ok) { App.Audio.playSuccess(); flashScreen('flash-green'); toast(`Logged unrecorded return ${r.parcel.trackingNumber}`); renderAll(); }
    });

    // Edit Parcel Modal
    const closeEd = () => $('modal-edit-parcel').classList.remove('open');
    $('btn-close-edit-modal').addEventListener('click', closeEd);
    $('btn-cancel-edit').addEventListener('click', closeEd);
    $('edit-parcel-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('edit-parcel-id').value;
      const cn = App.Couriers.normalizeTracking($('edit-tracking').value);
      const conflict = App.Storage.findByTracking(cn);
      if (conflict && conflict.id !== id) return toast(`Tracking ${cn} already exists.`, 'error');
      App.Storage.updateParcel(id, {
        trackingNumber: cn,
        orderId: $('edit-order-id').value.trim(),
        courier: $('edit-courier').value,
        dispatchDate: $('edit-dispatch-date').value,
        customerName: $('edit-customer-name').value.trim(),
        customerPhone: $('edit-customer-phone').value.trim(),
        codAmount: Number($('edit-cod-amount').value) || 0,
        notes: $('edit-notes').value.trim()
      });
      App.Storage.updateParcelStatus(id, $('edit-status').value);
      closeEd();
      renderAll();
      toast('Shipment updated.');
    });
    $('btn-delete-in-modal').addEventListener('click', () => {
      const id = $('edit-parcel-id').value;
      requireAdminPin('Delete shipment', () => {
        if (global.confirm('Delete this parcel permanently?')) {
          App.Storage.deleteParcel(id);
          closeEd();
          renderAll();
          toast('Parcel deleted.', 'warning');
        }
      });
    });
  }

  async function init() {
    App.Storage.load();
    bindEvents();
    hydrateSettingsForms();
    renderAll();

    // Hydrate from permanent Local Disk Database when running in MM-VIRSA-Ops.exe
    if (App.CloudSync) {
      const diskRes = await App.CloudSync.loadFromLocalDisk();
      if (diskRes.ok) renderAll();

      App.CloudSync.startAutoSyncLoop((dataChanged) => {
        if (dataChanged) renderAll();
        else renderApiAndSecurity();
      });

      const sc = App.CloudSync.loadConfig();
      if (sc.enabled && sc.endpointUrl) {
        App.CloudSync.syncWithCloud('startup').then((r) => {
          if (r.ok) renderAll();
        });
      }
    }

    // Automatic timely Live Courier Tracking (startup + every 5 minutes when API keys are set)
    if (App.TrackingAPI && App.TrackingAPI.startTimelyTrackingLoop) {
      App.TrackingAPI.startTimelyTrackingLoop(() => renderAll());
    }

    App.Security.initIdleMonitor(() => {
      $('lock-error-msg').textContent = '';
      $('inp-lock-pin').value = '';
      $('lock-overlay').classList.add('open');
      setTimeout(() => $('inp-lock-pin').focus(), 50);
    });

    if ('serviceWorker' in navigator && global.location && global.location.protocol === 'https:') {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    if (global.location && (global.location.hostname === '127.0.0.1' || global.location.hostname === 'localhost') && global.location.port === '8787') {
      const sendPing = () => fetch('/api/ping', { method: 'GET', cache: 'no-store' }).catch(() => {});
      sendPing();
      setInterval(sendPing, 3500);
      global.addEventListener('beforeunload', () => {
        if (navigator.sendBeacon) {
          try { navigator.sendBeacon('/api/bye'); } catch (_) {}
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
