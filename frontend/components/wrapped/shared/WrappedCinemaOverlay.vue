<template>
  <div class="cine" aria-hidden="true" />
</template>

<style scoped>
.cine {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 30;
  /* 静态浅暗角保留暗场层次，不再叠加噪点和全画面闪烁。 */
  background: radial-gradient(78% 66% at 50% 46%, transparent 40%, rgba(15, 31, 23, 0.16) 100%);
}
</style>
