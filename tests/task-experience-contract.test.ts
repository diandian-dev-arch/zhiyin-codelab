import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { parse, compileTemplate } = webRequire('vue/compiler-sfc');

function view(name: string) {
  const filename = new URL(`../apps/web/src/views/${name}.vue`, import.meta.url).pathname;
  const source = readFileSync(new URL(`../apps/web/src/views/${name}.vue`, import.meta.url), 'utf8');
  const parsed = parse(source, { filename });
  const template = parsed.descriptor.template.content as string;
  const compiled = compileTemplate({ source: template, filename, id: `task-experience-${name}` });
  return { source, template, errors: [...parsed.errors, ...compiled.errors], ast: compiled.ast };
}

function elements(node: any): any[] {
  if (!node) return [];
  return [
    ...(node.type === 1 ? [node] : []),
    ...(node.children ?? []).flatMap(elements),
    ...(node.branches ?? []).flatMap(elements),
  ];
}

function attribute(node: any, name: string) {
  return node.props?.find((prop: any) => prop.type === 6 && prop.name === name)?.value?.content;
}

function withClass(ast: any, className: string) {
  return elements(ast).filter(node => attribute(node, 'class')?.split(/\s+/).includes(className));
}

describe('task experience information hierarchy', () => {
  it.each(['Tasks', 'ProjectTask', 'Assignments'])('%s keeps a valid Vue template', name => {
    expect(view(name).errors).toEqual([]);
  });

  it('puts the existing todo choices before rule filters without removing either filter or loaded scope', () => {
    const { template, source, ast } = view('Tasks');
    expect(template.indexOf('class="work-filter"')).toBeLessThan(template.indexOf('class="collection-toolbar"'));
    expect(template).toContain('aria-label="按待办筛选"');
    expect(template).toContain('aria-label="按规则状态筛选"');
    expect(template).toContain('搜索、筛选与统计仅针对已加载任务');
    expect(source).toContain('const workFilter = ref("all")');
    expect(source).toContain('const ruleFilter = ref("all")');
    const guide = withClass(ast, 'task-type-guide')[0];
    expect(guide.tag).toBe('details');
    expect(guide.props.some((prop: any) => prop.name === 'open' || prop.arg?.content === 'open')).toBe(false);
    expect(template).toContain('to="/assignments"');
    expect(template).not.toContain('class="learning-flow"');
  });

  it('retains one project-content navigation and all submit, own-work, feedback and showcase paths', () => {
    const { template, ast } = view('ProjectTask');
    const navigation = withClass(ast, 'task-navigation');
    expect(navigation).toHaveLength(1);
    expect(elements(navigation[0]).filter(node => node.tag === 'button')).toHaveLength(3);
    expect(template).not.toContain('class="task-workflow"');
    expect(template).toContain('查看我的作品');
    expect(template).toContain("listFilter = 'mine'");
    expect(template).toContain('提交改进版本');
    expect(template).toContain('保存并提交作品');
    expect(template).toContain('待教师反馈');
    expect(template).toContain('pendingCount');
    expect(template).toContain('优秀作品');
    const guide = withClass(ast, 'participation-guide')[0];
    expect(guide.tag).toBe('details');
    expect(guide.props.some((prop: any) => prop.name === 'open' || prop.arg?.content === 'open')).toBe(false);
    expect(elements(guide).filter(node => node.tag === 'li')).toHaveLength(4);
  });

  it('uses a named assignment section under the workspace main and keeps historical task navigation', () => {
    const { template, ast } = view('Assignments');
    const root = withClass(ast, 'assignments-page')[0];
    expect(root.tag).toBe('section');
    expect(attribute(root, 'aria-label')).toBe('课程作业');
    expect(elements(ast).filter(node => node.tag === 'main')).toHaveLength(0);
    expect(template).toContain('函数、文件或一组连续子任务');
    expect(template).toContain('历史项目任务');
    expect(template).toContain(':to="`/tasks/${a.id}`"');
    expect(template).toContain('预览学生视图');
    expect(template).toContain('创建并发布');
  });
});
