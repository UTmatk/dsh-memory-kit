/**
 * dsh-memory-panel —— 客户端半边。
 *
 * 往「设置」里加一节「记忆」，内容是同源 iframe：/memory-panel/
 * 页面本身已是完整应用（列表 / 检索 / 一键同步），嵌进来比在 React 里重写一遍
 * 列表逻辑更省，也不会和宿主样式打架；同源，没有跨域或鉴权问题。
 *
 * ⚠ 契约（踩过的坑）：factory 必须 **return** 插件对象 { inject, apply }。
 * 在这里写 `exports.xxx = ...` 或 `module.exports` 会在浏览器端 import 时抛
 * 「exports is not defined」，导致整个 web boot 失败、应用起不来。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SRC = '/memory-panel/';

    function MemoryPanel() {
      return h('iframe', {
        src: SRC,
        title: 'DSH 长期记忆',
        style: {
          width: '100%',
          height: 'calc(100vh - 150px)',
          minHeight: '520px',
          border: '0',
          borderRadius: '12px',
          background: 'transparent',
        },
      });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 座位名或参数若在别的版本里变了，宁可这一节不出现，也绝不把 boot 打挂。
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'memory',
            order: 60,
            label: () => '记忆',
          }, MemoryPanel));
        } catch (error) {
          console.error('[dsh-memory-panel] settings.section 注册失败：', error);
        }
      },
    };
  },
});
