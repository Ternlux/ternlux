/**
 * Render a chat visual ({ type, title, data: [{ x, y }] }) to a PNG, for
 * messaging platforms that cannot run the app's React charts.
 *
 * The chart is drawn by the same Chart.js the app ships, inside a hidden
 * window, and read back with canvas.toDataURL — no screen capture, so it works
 * with the window never shown. Types without an image form (table, kpi, box)
 * return null and are sent as text or CSV by the caller.
 */

const fs = require('fs');
const path = require('path');

const IMAGE_TYPES = new Set(['bar', 'line', 'pie', 'scatter']);
const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
const WIDTH = 1000;
const HEIGHT = 560;

let chartSource = null;
function chartJs() {
  if (!chartSource) {
    // Packaged: scripts/minify-dist.js copies the UMD build into vendor/.
    // Development: read it from node_modules — chart.js's package `exports`
    // hide dist/ from require.resolve, so go through its main entry
    // (dist/chart.cjs) and take the UMD build beside it.
    const vendored = path.join(__dirname, 'vendor', 'chart.umd.min.js');
    const file = fs.existsSync(vendored)
      ? vendored
      : path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
    chartSource = fs.readFileSync(file, 'utf8');
  }
  return chartSource;
}

// The Chart.js config for a visual. Exported for tests.
function chartConfig(visual) {
  const data = (visual.data || []).filter((d) => d && typeof d === 'object');
  const labels = data.map((d) => String(d.x));
  const values = data.map((d) => Number(d.y));
  const title = { display: Boolean(visual.title), text: visual.title || '', font: { size: 18 } };
  const base = { animation: false, responsive: false, devicePixelRatio: 2, plugins: { title, legend: { display: false } } };
  switch (visual.type) {
    case 'pie':
      return {
        type: 'pie',
        data: { labels, datasets: [{ data: values, backgroundColor: labels.map((_l, i) => COLORS[i % COLORS.length]) }] },
        options: { ...base, plugins: { ...base.plugins, legend: { display: true, position: 'right' } } },
      };
    case 'scatter':
      return {
        type: 'scatter',
        data: { datasets: [{ data: data.map((d) => ({ x: Number(d.x), y: Number(d.y) })), backgroundColor: COLORS[0] }] },
        options: base,
      };
    case 'line':
      return {
        type: 'line',
        data: { labels, datasets: [{ data: values, borderColor: COLORS[1], backgroundColor: `${COLORS[1]}33`, fill: true, tension: 0.25 }] },
        options: { ...base, scales: { y: { beginAtZero: true } } },
      };
    default:
      return {
        type: 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: COLORS[0] }] },
        options: { ...base, scales: { y: { beginAtZero: true } } },
      };
  }
}

/**
 * @param {object} visual
 * @param {Function} BrowserWindow  electron's, injected so this module loads outside Electron
 * @returns {Promise<Buffer|null>}
 */
async function renderChartPng(visual, BrowserWindow) {
  if (!visual || !IMAGE_TYPES.has(visual.type) || !Array.isArray(visual.data) || visual.data.length === 0) {
    return null;
  }
  const html = `<!doctype html><html><body style="margin:0;background:#fff">
<canvas id="c" width="${WIDTH}" height="${HEIGHT}" style="width:${WIDTH}px;height:${HEIGHT}px"></canvas>
<script>${chartJs()}</script></body></html>`;
  const win = new BrowserWindow({
    show: false, width: WIDTH, height: HEIGHT,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const config = JSON.stringify(chartConfig(visual));
    const dataUrl = await win.webContents.executeJavaScript(`(() => {
      // Chart.js clears to transparent; paint white under every draw so the
      // PNG reads on dark chat themes too.
      Chart.register({ id: 'whiteBackground', beforeDraw(c) {
        c.ctx.save(); c.ctx.fillStyle = '#fff'; c.ctx.fillRect(0, 0, c.width, c.height); c.ctx.restore();
      } });
      new Chart(document.getElementById('c').getContext('2d'), ${config});
      return document.getElementById('c').toDataURL('image/png');
    })()`);
    return Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
  } finally {
    win.destroy();
  }
}

module.exports = { renderChartPng, chartConfig, IMAGE_TYPES };
