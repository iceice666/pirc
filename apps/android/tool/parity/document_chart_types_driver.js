(function () {
  const canvas = document.getElementById('chart');
  const container = document.getElementById('chart-container');
  const probe = document.getElementById('probe');
  const type = canvas.getAttribute('data-chart-type');
  const dpr = Number(canvas.getAttribute('data-dpr'));
  const pointData = type === 'scatter' || type === 'bubble';
  const circular = ['pie', 'doughnut', 'polarArea'].includes(type);
  const colors = ['#3b82f6', '#f97316', '#22c55e'];
  const initialData = pointData
    ? [
        { x: 2, y: 3, r: 12 },
        { x: 5, y: 7, r: 16 },
        { x: 8, y: 5, r: 10 },
      ]
    : [3, 7, 5];
  const updatedData = pointData
    ? [
        { x: 2, y: 6, r: 14 },
        { x: 5, y: 2, r: 10 },
        { x: 8, y: 4, r: 12 },
      ]
    : [6, 2, 4];
  let chart,
    firstPoint,
    pending = false,
    serial = 0,
    phase = 'initial';
  const clicks = [];
  function active(elements) {
    return elements.map((e) => ({ datasetIndex: e.datasetIndex, index: e.index }));
  }
  function snapshot() {
    const rect = canvas.getBoundingClientRect(),
      style = getComputedStyle(canvas);
    const metadata = chart.getDatasetMeta(0);
    const items = metadata.data.map((element, index) => {
      const fields = circular
        ? ['x', 'y', 'startAngle', 'endAngle', 'circumference', 'innerRadius', 'outerRadius']
        : type === 'bar'
          ? ['x', 'y', 'base', 'width', 'height']
          : ['x', 'y'];
      const center = element.getCenterPoint(true);
      return {
        index,
        value: chart.data.datasets[0].data[index],
        visible: chart.isDatasetVisible(0) && chart.getDataVisibility(index),
        geometry: Object.fromEntries(
          fields.map((key) => [key, element.getProps(fields, true)[key]]),
        ),
        center: { x: center.x, y: center.y },
        color: element.options.backgroundColor,
        radius: element.options.radius ?? null,
      };
    });
    if (!firstPoint) firstPoint = { ...items[0].center };
    const tooltip = chart.tooltip;
    return {
      phase,
      serial,
      type,
      version: Chart.version,
      chart: {
        width: chart.width,
        height: chart.height,
        dpr: chart.currentDevicePixelRatio,
        area: { ...chart.chartArea },
      },
      canvas: {
        width: canvas.width,
        height: canvas.height,
        css: {
          width: style.width,
          height: style.height,
          display: style.display,
          boxSizing: style.boxSizing,
        },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      },
      datasetVisible: chart.isDatasetVisible(0),
      items,
      paintPoints: [
        ...items.filter((e) => e.visible).map((e) => ({ name: 'item-' + e.index, ...e.center })),
        { name: 'initial-first', ...firstPoint },
        { name: 'clear-corner', x: 2, y: 2 },
        ...(type === 'doughnut'
          ? [{ name: 'doughnut-hole', x: items[0].geometry.x, y: items[0].geometry.y }]
          : []),
      ],
      strokePoints:
        type === 'line' && chart.isDatasetVisible(0)
          ? [
              {
                name: 'connection-0-1',
                x: (items[0].center.x + items[1].center.x) / 2,
                y: (items[0].center.y + items[1].center.y) / 2,
              },
            ]
          : [],
      chartActive: active(chart.getActiveElements()),
      tooltip: {
        opacity: tooltip.opacity,
        title: tooltip.title || [],
        body: (tooltip.body || []).map((b) => ({
          before: b.before,
          lines: b.lines,
          after: b.after,
        })),
        active: active(tooltip.getActiveElements()),
        bounds: {
          x: tooltip.x ?? null,
          y: tooltip.y ?? null,
          width: tooltip.width ?? null,
          height: tooltip.height ?? null,
        },
      },
      legend: chart.legend.legendHitBoxes.map((box, index) => {
        const item = chart.legend.legendItems[index];
        return {
          text: item.text,
          hidden: item.hidden,
          index: item.index ?? null,
          datasetIndex: item.datasetIndex ?? null,
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
        };
      }),
      clicks: clicks.slice(),
    };
  }
  function report() {
    try {
      probe.textContent = JSON.stringify(snapshot());
    } catch (e) {
      probe.textContent = JSON.stringify({ error: e.name + ': ' + e.message, phase });
    }
  }
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        pending = false;
        serial++;
        report();
      }),
    );
  }
  try {
    chart = new Chart(canvas, {
      type,
      data: {
        labels: ['A', 'B', 'C'],
        datasets: [
          {
            label: 'Data',
            data: initialData,
            backgroundColor: circular ? colors : colors[0],
            borderColor: '#2563eb',
            pointRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        animation: false,
        maintainAspectRatio: false,
        devicePixelRatio: dpr,
        onClick(event, elements) {
          clicks.push({
            type: event.type,
            nativeType: event.native.type,
            active: active(elements),
          });
        },
      },
    });
    canvas.addEventListener('click', schedule);
    canvas.addEventListener('mouseout', schedule);
    document.getElementById('update').onclick = () => {
      phase = 'updated';
      chart.data.datasets[0].data = updatedData;
      chart.update('none');
      schedule();
    };
    document.getElementById('resize').onclick = () => {
      phase = 'resized';
      const width = Number(canvas.getAttribute('data-width')) + 20;
      container.style.width = width + 'px';
      canvas.style.width = width + 'px';
      let turns = 0;
      function resized() {
        if (chart.width !== width && ++turns < 60) {
          requestAnimationFrame(resized);
          return;
        }
        serial++;
        report();
      }
      requestAnimationFrame(() => requestAnimationFrame(resized));
    };
    report();
  } catch (e) {
    probe.textContent = JSON.stringify({ error: e.name + ': ' + e.message, phase });
  }
})();
