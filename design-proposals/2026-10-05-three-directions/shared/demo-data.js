/*
 * 知因 CodeLab · 三版视觉方案共用的示例数据
 * 仅用于设计原型演示：项目、文件、行号与代码均为虚构样例，不代表任何真实分析结果。
 * 三个方案读取同一份数据，保证比较的只是视觉与交互，而不是内容。
 */
window.ZHIYIN_DEMO = {
  user: { name: '林知夏', role: '教师', initials: '林' },
  nav: [
    { id: 'projects', label: '我的项目', count: 6 },
    { id: 'tasks', label: '实训任务', count: 3 },
    { id: 'settings', label: '设置' },
  ],
  library: [
    { id: 'canteen', name: '校园食堂订餐系统', status: 'succeeded', lang: 'Java · Vue', updated: '今天 09:42' },
    { id: 'library', name: '图书馆座位预约', status: 'running', lang: 'Python · React', updated: '今天 10:15' },
    { id: 'lab', name: '实验室设备借还', status: 'succeeded', lang: 'Go · Vue', updated: '昨天' },
    { id: 'club', name: '社团活动报名平台', status: 'idle', lang: 'Node · Vue', updated: '9 月 28 日' },
    { id: 'parcel', name: '快递驿站取件码', status: 'succeeded', lang: 'Java · 小程序', updated: '9 月 26 日' },
    { id: 'notes', name: '课堂笔记协作', status: 'failed', lang: 'TypeScript', updated: '9 月 21 日' },
  ],
  project: {
    id: 'canteen',
    name: '校园食堂订餐系统',
    repo: 'canteen-order',
    stack: ['Spring Boot 3', 'MyBatis', 'Vue 3', 'Redis'],
    owner: '软件 2203 · 第 4 组',
    savedAt: '2026-10-05 09:42',
    mode: '完整分析',
    model: 'gpt-5.1 · 个人账户',
    stats: {
      files: 142,
      importedLines: 12406,
      readLines: 4812,
      skipped: 37,
      modelCalls: 23,
      citations: 31,
      citationsVerified: 31,
      costCny: 0.42,
      minutes: 4.6,
    },
    purpose:
      '面向在校师生的食堂线上订餐系统：学生浏览各窗口菜单、加入购物车并在线支付，后厨按取餐时段接单备餐，取餐时凭取餐码核销。管理端负责菜品上下架、库存与营业时段配置。',
    audiences: ['学生下单', '后厨接单', '窗口核销', '管理员配置'],
    modules: [
      { id: 'auth', label: '身份与登录', files: 14, lines: 1180, read: 420, desc: '校园统一认证换取会话，区分学生、后厨与管理员角色。', paths: ['auth/AuthController.java', 'auth/JwtFilter.java'] },
      { id: 'menu', label: '菜单与库存', files: 26, lines: 2310, read: 980, desc: '窗口、菜品与每日库存；库存按取餐时段拆分，缓存在 Redis。', paths: ['menu/MenuService.java', 'menu/StockMapper.xml'] },
      { id: 'order', label: '订单与支付', files: 31, lines: 3120, read: 1860, desc: '购物车结算、订单状态机、支付回调与超时取消，是全项目最核心的链路。', paths: ['order/OrderService.java', 'pay/PaymentCallbackController.java'] },
      { id: 'kitchen', label: '后厨看板', files: 19, lines: 1640, read: 820, desc: '按取餐时段聚合订单，推送备餐清单并更新出餐状态。', paths: ['kitchen/KitchenBoard.vue', 'kitchen/BoardService.java'] },
      { id: 'notify', label: '消息通知', files: 11, lines: 760, read: 260, desc: '出餐提醒与超时取消通知，通过企业微信模板消息发送。', paths: ['notify/NoticeSender.java'] },
      { id: 'web', label: '学生端前端', files: 41, lines: 3396, read: 472, desc: 'Vue 3 单页应用：菜单浏览、购物车、订单与取餐码页面。', paths: ['web/src/views/CartView.vue'] },
    ],
    chain: {
      title: '学生下单并完成支付',
      steps: [
        { id: 's1', label: '购物车结算', path: 'web/src/views/CartView.vue', range: '118–134', module: 'web', note: '前端汇总菜品金额，提交取餐时段。' },
        { id: 's2', label: '创建订单', path: 'order/OrderController.java', range: '42–61', module: 'order', note: '校验时段是否营业，调用下单服务。' },
        { id: 's3', label: '扣减库存', path: 'order/OrderService.java', range: '86–104', module: 'order', note: '读取时段库存后扣减，写入订单明细。' },
        { id: 's4', label: '发起支付', path: 'pay/PaymentService.java', range: '27–40', module: 'order', note: '生成预支付单，订单进入待支付。' },
        { id: 's5', label: '支付回调', path: 'pay/PaymentCallbackController.java', range: '31–47', module: 'order', note: '支付平台回调后将订单标记为已支付。' },
        { id: 's6', label: '后厨接单', path: 'kitchen/BoardService.java', range: '55–72', module: 'kitchen', note: '按取餐时段推送到后厨看板。' },
      ],
    },
    route: [
      { step: 1, title: '先看订单状态机', path: 'order/OrderStatus.java', why: '六种状态与合法流转都在这里，读懂它再看其他代码会轻松很多。' },
      { step: 2, title: '沿着下单主流程', path: 'order/OrderService.java', why: '从 createOrder 进入，依次经过库存、金额与支付。' },
      { step: 3, title: '对照支付回调', path: 'pay/PaymentCallbackController.java', why: '理解订单如何从待支付变为已支付，以及失败时的回滚。' },
      { step: 4, title: '最后看后厨看板', path: 'kitchen/BoardService.java', why: '看订单如何按时段聚合，体会读写分离的设计。' },
    ],
    findings: [
      {
        id: 'f1',
        level: 'high',
        levelLabel: '高',
        title: '并发下单时库存可能被超卖',
        summary: '扣减库存先查询后更新，两步之间没有加锁或条件更新。高峰期两个请求可能读到同一库存值，导致卖出数量超过实际库存。',
        path: 'order/OrderService.java',
        start: 88,
        end: 101,
        verify: '用 JMeter 对同一菜品 50 并发下单，库存设为 10，观察成功订单数是否大于 10。',
        fix: '改为条件更新：UPDATE stock SET remain = remain - #{qty} WHERE id = #{id} AND remain >= #{qty}，并以影响行数判断是否扣减成功。',
        review: '已复核：读取了 StockMapper.xml 第 12–20 行，确认没有乐观锁版本号或 WHERE 条件保护。',
      },
      {
        id: 'f2',
        level: 'high',
        levelLabel: '高',
        title: '支付回调未校验签名',
        summary: '回调接口直接根据请求中的订单号把订单标记为已支付，没有校验支付平台签名与金额，伪造请求即可“免费”下单。',
        path: 'pay/PaymentCallbackController.java',
        start: 33,
        end: 44,
        verify: '构造一个不带签名的 POST 请求访问 /pay/callback，观察订单状态是否变为 PAID。',
        fix: '使用支付 SDK 验签，并比对回调金额与订单应付金额；回调处理需幂等。',
        review: '已复核：全项目搜索 verifySign / signature 无结果。',
      },
      {
        id: 'f3',
        level: 'medium',
        levelLabel: '中',
        title: '前端用浮点数累计金额',
        summary: '购物车合计使用 Number 相加，例如 0.1 + 0.2 会出现精度误差；后端虽然重新计价，但页面展示金额可能与实付不一致。',
        path: 'web/src/views/CartView.vue',
        start: 120,
        end: 131,
        verify: '加入单价 3.10 与 2.20 的菜品各一份，观察合计是否显示 5.300000000000001。',
        fix: '以“分”为单位使用整数计算，展示时再格式化为元。',
        review: '已复核：后端 OrderService 第 92 行使用 BigDecimal 重新计价，因此影响限于展示。',
      },
    ],
    withdrawn: [
      { title: '订单号可被遍历', reason: '复核发现订单查询接口按登录用户过滤（OrderMapper.xml 第 31 行），撤回该线索。' },
    ],
    boundary: [
      '静态源码分析 · 未执行项目或测试',
      '已读 4,812 / 12,406 行，约 39%',
      '跳过 37 个文件：依赖、构建产物与图片资源',
      '引用校验仅确认出处位于实际读过的行段',
    ],
  },
  /* 分析轨迹：依据真实事件类型模拟（read / search / investigate），不预估百分比 */
  events: [
    { kind: 'plan', label: '研读项目结构与配置', phase: 1 },
    { kind: 'read', path: 'pom.xml', range: '1–86', phase: 1 },
    { kind: 'read', path: 'application.yml', range: '1–54', phase: 1 },
    { kind: 'read', path: 'order/OrderStatus.java', range: '1–38', phase: 1 },
    { kind: 'search', label: '搜索 “createOrder” 的调用方', phase: 2 },
    { kind: 'read', path: 'order/OrderController.java', range: '30–75', phase: 2 },
    { kind: 'read', path: 'order/OrderService.java', range: '60–140', phase: 2 },
    { kind: 'read', path: 'menu/StockMapper.xml', range: '1–40', phase: 2 },
    { kind: 'search', label: '搜索 “verifySign” 与 “signature”', phase: 2 },
    { kind: 'read', path: 'pay/PaymentCallbackController.java', range: '1–60', phase: 2 },
    { kind: 'read', path: 'kitchen/BoardService.java', range: '40–90', phase: 2 },
    { kind: 'read', path: 'web/src/views/CartView.vue', range: '100–150', phase: 2 },
    { kind: 'verify', label: '反证复核 4 条问题线索，撤回 1 条', phase: 3 },
    { kind: 'cite', label: '校验 31 处引用出处', phase: 3 },
    { kind: 'done', label: '导读已生成', phase: 3 },
  ],
  phases: [
    { id: 1, label: '研读项目材料' },
    { id: 2, label: '按需调查取证' },
    { id: 3, label: '复核并形成导读' },
  ],
  /* 被引用文件的源码片段，行号与 findings / chain 对应 */
  sources: {
    'order/OrderService.java': {
      lang: 'java',
      start: 84,
      code: `    @Transactional
    public Order createOrder(Long userId, CreateOrderCmd cmd) {
        Slot slot = slotService.requireOpen(cmd.getSlotId());
        BigDecimal total = BigDecimal.ZERO;
        for (CartItem item : cmd.getItems()) {
            Stock stock = stockMapper.selectBySlot(item.getDishId(), slot.getId());
            if (stock.getRemain() < item.getQty()) {
                throw new BizException("库存不足：" + item.getDishName());
            }
            total = total.add(item.getPrice().multiply(BigDecimal.valueOf(item.getQty())));
            // 先查询再更新，两步之间没有任何并发保护
            stock.setRemain(stock.getRemain() - item.getQty());
            stockMapper.updateById(stock);
        }
        Order order = Order.pending(userId, slot, total);
        orderMapper.insert(order);
        orderItemMapper.batchInsert(order.getId(), cmd.getItems());
        delayQueue.offer(order.getId(), Duration.ofMinutes(15));
        return order;
    }`,
    },
    'pay/PaymentCallbackController.java': {
      lang: 'java',
      start: 29,
      code: `@RestController
@RequestMapping("/pay")
public class PaymentCallbackController {

    @PostMapping("/callback")
    public String callback(@RequestBody Map<String, String> body) {
        String orderNo = body.get("out_trade_no");
        Order order = orderMapper.selectByNo(orderNo);
        if (order == null) {
            return "FAIL";
        }
        // 未校验签名与金额，直接标记为已支付
        order.setStatus(OrderStatus.PAID);
        order.setPaidAt(LocalDateTime.now());
        orderMapper.updateById(order);
        kitchenBoard.push(order);
        return "SUCCESS";
    }
}`,
    },
    'web/src/views/CartView.vue': {
      lang: 'ts',
      start: 116,
      code: `const cart = useCartStore()
const slot = ref<Slot>()

const total = computed(() => {
  let sum = 0
  for (const item of cart.items) {
    // 以元为单位的浮点数直接相加
    sum += item.price * item.qty
  }
  return sum
})

async function checkout() {
  const order = await api.createOrder({
    slotId: slot.value!.id,
    items: cart.items,
  })
  router.push({ name: 'pay', params: { id: order.id } })
}`,
    },
    'order/OrderStatus.java': {
      lang: 'java',
      start: 1,
      code: `package edu.campus.canteen.order;

/** 订单状态与合法流转 */
public enum OrderStatus {
    PENDING_PAY,   // 待支付，15 分钟未支付自动取消
    PAID,          // 已支付，等待后厨接单
    COOKING,       // 备餐中
    READY,         // 待取餐，推送取餐码
    DONE,          // 已核销
    CANCELLED;     // 已取消，释放库存

    public boolean canMoveTo(OrderStatus next) {
        return switch (this) {
            case PENDING_PAY -> next == PAID || next == CANCELLED;
            case PAID -> next == COOKING || next == CANCELLED;
            case COOKING -> next == READY;
            case READY -> next == DONE;
            default -> false;
        };
    }
}`,
    },
    'kitchen/BoardService.java': {
      lang: 'java',
      start: 55,
      code: `    public void push(Order order) {
        String key = "board:" + order.getSlotId();
        redis.opsForList().rightPush(key, order.getId());
        BoardCard card = BoardCard.from(order, orderItemMapper.listByOrder(order.getId()));
        socket.convertAndSend("/topic/board/" + order.getWindowId(), card);
    }

    public List<BoardCard> listBySlot(Long slotId) {
        List<Long> ids = redis.opsForList().range("board:" + slotId, 0, -1);
        return ids.stream()
            .map(orderMapper::selectById)
            .filter(o -> o.getStatus() == OrderStatus.PAID || o.getStatus() == OrderStatus.COOKING)
            .map(o -> BoardCard.from(o, orderItemMapper.listByOrder(o.getId())))
            .toList();
    }`,
    },
  },
  /* 仓库文件清单（用于星图 / 热力格 / 知识树），read 为本次是否读过 */
  files: [
    { path: 'pom.xml', module: 'config', lines: 86, read: true },
    { path: 'application.yml', module: 'config', lines: 54, read: true },
    { path: 'auth/AuthController.java', module: 'auth', lines: 112, read: true },
    { path: 'auth/JwtFilter.java', module: 'auth', lines: 88, read: true },
    { path: 'auth/RoleGuard.java', module: 'auth', lines: 64, read: false },
    { path: 'auth/CasClient.java', module: 'auth', lines: 140, read: false },
    { path: 'menu/MenuController.java', module: 'menu', lines: 96, read: false },
    { path: 'menu/MenuService.java', module: 'menu', lines: 210, read: true },
    { path: 'menu/StockMapper.xml', module: 'menu', lines: 40, read: true },
    { path: 'menu/DishMapper.xml', module: 'menu', lines: 72, read: false },
    { path: 'menu/SlotService.java', module: 'menu', lines: 128, read: true },
    { path: 'order/OrderController.java', module: 'order', lines: 140, read: true },
    { path: 'order/OrderService.java', module: 'order', lines: 268, read: true },
    { path: 'order/OrderStatus.java', module: 'order', lines: 38, read: true },
    { path: 'order/OrderMapper.xml', module: 'order', lines: 96, read: true },
    { path: 'order/TimeoutCanceller.java', module: 'order', lines: 74, read: true },
    { path: 'pay/PaymentService.java', module: 'order', lines: 118, read: true },
    { path: 'pay/PaymentCallbackController.java', module: 'order', lines: 60, read: true },
    { path: 'kitchen/BoardService.java', module: 'kitchen', lines: 132, read: true },
    { path: 'kitchen/BoardSocket.java', module: 'kitchen', lines: 58, read: false },
    { path: 'kitchen/KitchenBoard.vue', module: 'kitchen', lines: 240, read: true },
    { path: 'notify/NoticeSender.java', module: 'notify', lines: 96, read: true },
    { path: 'notify/TemplateRegistry.java', module: 'notify', lines: 70, read: false },
    { path: 'web/src/views/MenuView.vue', module: 'web', lines: 286, read: false },
    { path: 'web/src/views/CartView.vue', module: 'web', lines: 190, read: true },
    { path: 'web/src/views/OrderView.vue', module: 'web', lines: 220, read: false },
    { path: 'web/src/views/PickupCode.vue', module: 'web', lines: 132, read: false },
    { path: 'web/src/api/order.ts', module: 'web', lines: 64, read: true },
    { path: 'web/src/stores/cart.ts', module: 'web', lines: 88, read: true },
    { path: 'web/src/router.ts', module: 'web', lines: 72, read: false },
  ],
};
