# Blog Content Format

文章使用 `.mdx` 格式 (Astro 原生支援)。除了標準 Markdown 語法之外,文章內可以使用 ECharts 圖表元件:

```mdx
<ECharts option={{
  xAxis: { type: "category", data: ["Mon", "Tue", "Wed"] },
  yAxis: { type: "value" },
  series: [{ data: [120, 200, 150], type: "bar" }],
}} />
```

`<ECharts>` 接受 `option` (ECharts option 物件)、`height` (CSS 高度,預設 360px)、`class` 屬性。圖表在 client 端 lazy-load echarts 套件渲染,自動偵測暗色模式。

不需在文章中 import 元件 — 發布到 `src/content/blog/` 的 MDX 檔案可全域使用 `<ECharts>`。


## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
