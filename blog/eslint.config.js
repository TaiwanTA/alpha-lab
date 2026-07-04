// ESLint flat config — antfu style + Astro plugin
import antfu from '@antfu/eslint-config';
import astroPlugin from 'eslint-plugin-astro';

export default antfu(
  {
    type: 'lib',
    typescript: true,
    stylistic: {
      indent: 2,
      quotes: 'single',
      semi: true,
    },
  },
  // Astro 檔案 (.astro)
  ...astroPlugin.configs.recommended,
  {
    files: ['**/*.astro'],
    rules: {
      // Astro 內部 JSX-like 語法,放寬一些規則
      'no-unused-vars': 'off',
      // Astro frontmatter 必須用 top-level await 處理 async data
      'antfu/no-top-level-await': 'off',
      // Astro plugin 把 <style> block 誤判為 JSX,關掉這些 style 規則
      'style/jsx-one-expression-per-line': 'off',
      'style/no-multiple-empty-lines': 'off',
      'style/eol-last': 'off',
      'style/brace-style': 'off',
      'style/jsx-closing-tag-location': 'off',
      'style/indent': 'off',
      'style/no-trailing-spaces': 'off',
      // MDX 副檔名用到 mdx 整合,允許未標型別的元件標籤
      'no-undef': 'off',
    },
  },
  {
    ignores: [
      'dist/',
      '.astro/',
      'node_modules/',
    ],
  },
);
