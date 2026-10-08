<template>
  <!-- 与主界面一致的静态薄荷奶油底色。
       注意：`fixed inset-0` 在画幅舞台里指的是**舞台设计盒**而不是浏览器视口
       （.wr-stage 带 transform，是其 fixed 后代的包含块）。这是刻意的：
       底色跟着画面一起裁切、缩放和导出。 -->
  <div class="wrapped-backdrop fixed inset-0 pointer-events-none select-none z-0" aria-hidden="true" />
</template>

<style scoped>
.wrapped-backdrop {
  background:
    radial-gradient(ellipse at 4% 5%, rgba(198, 243, 223, 0.4), transparent 52%),
    radial-gradient(ellipse at 96% 96%, rgba(212, 242, 226, 0.28), transparent 48%);
}
</style>
