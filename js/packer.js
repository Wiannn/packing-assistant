// packer.js - 3D 装箱算法（极值点 + 6 种 90° 朝向枚举）
// 坐标系：x=长，y=高，z=宽；货物 min 角落在 (x,y,z)

// 生成 box 的所有正交朝向（去重），返回 [{l,w,h}] 三种维度映射到 (x,y,z) 的组合
function orientations(box) {
  const a = [box.l, box.w, box.h];
  const seen = new Set();
  const out = [];
  // 三个维度全排列
  const idx = [0, 1, 2];
  const perms = (arr) => {
    if (arr.length === 1) return [arr];
    const r = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const tail of perms(rest)) r.push([arr[i], ...tail]);
    }
    return r;
  };
  for (const p of perms(idx)) {
    const key = p.map(i => a[i]).join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ l: a[p[0]], h: a[p[1]], w: a[p[2]] }); // x=a[p0], y=a[p1], z=a[p2]
  }
  return out;
}

// AABB 重叠检测（排除仅边/面接触）
function overlap(a, b) {
  return a.x < b.x + b.l - 1e-6 && a.x + a.l > b.x + 1e-6 &&
         a.y < b.y + b.h - 1e-6 && a.y + a.h > b.y + 1e-6 &&
         a.z < b.z + b.w - 1e-6 && a.z + a.w > b.z + 1e-6;
}

class Packer {
  constructor(L, W, H) {
    this.L = L; this.W = W; this.H = H; // 长/宽/高 容器
    this.placed = [];
    this.ep = [{ x: 0, y: 0, z: 0 }]; // 极值点
  }

  fits(item) {
    // 边界
    if (item.x < -1e-6 || item.z < -1e-6 || item.y < -1e-6) return false;
    if (item.x + item.l > this.L + 1e-6) return false;
    if (item.z + item.w > this.W + 1e-6) return false;
    if (item.y + item.h > this.H + 1e-6) return false;
    // 碰撞
    for (const p of this.placed) if (overlap(item, p)) return false;
    return true;
  }

  // 尝试放置一件货物，返回放置结果或 null
  tryPlace(box) {
    const orients = orientations(box);
    let best = null;
    let bestScore = null;
    for (const o of orients) {
      for (const p of this.ep) {
        const item = { x: p.x, y: p.y, z: p.z, l: o.l, w: o.w, h: o.h };
        if (!this.fits(item)) continue;
        // 贴底优先：需要 item 支撑（其下方有已放置物或贴地面）
        const supported = this.isSupported(item);
        if (!supported) continue;
        // 评分：越低越靠角落/底部
        // 权重：y(底) > z(前) > x(左)
        const score = item.y * 1e6 + item.z * 1e3 + item.x;
        if (bestScore === null || score < bestScore) {
          bestScore = score;
          best = item;
        }
      }
    }
    return best;
  }

  // 该货物底部是否有支撑（贴地面 或 下方有箱体面托住）
  isSupported(item) {
    if (item.y <= 1e-6) return true;
    for (const p of this.placed) {
      // x/z 投影重叠 且 顶面接近 item.y
      const xzOverlap = item.x < p.x + p.l - 1e-6 && item.x + item.l > p.x + 1e-6 &&
                        item.z < p.z + p.w - 1e-6 && item.z + item.w > p.z + 1e-6;
      if (xzOverlap && Math.abs(p.y + p.h - item.y) < 1e-6) return true;
    }
    return false;
  }

  place(item) {
    this.placed.push(item);
    // 生成新极值点：箱体顶面后角、右侧后角、前方上角
    this.ep.push({ x: item.x + item.l, y: item.y, z: item.z });
    this.ep.push({ x: item.x, y: item.y + item.h, z: item.z });
    this.ep.push({ x: item.x, y: item.y, z: item.z + item.w });
    // 去除被任何已放置箱体包含的极值点（简化）
    this.ep = this.ep.filter(pt => {
      for (const p of this.placed) {
        if (pt.x >= p.x + 1e-6 && pt.x <= p.x + p.l - 1e-6 &&
            pt.y >= p.y + 1e-6 && pt.y <= p.y + p.h - 1e-6 &&
            pt.z >= p.z + 1e-6 && pt.z <= p.z + p.w - 1e-6) return false;
      }
      return true;
    });
  }

  // 主入口：货物列表 [{l,w,h,name,color,id}]，按数量展开
  packAll(items) {
    this.placed = [];
    this.ep = [{ x: 0, y: 0, z: 0 }];
    // 展开成单件列表
    const flat = [];
    for (const it of items) {
      for (let i = 0; i < (it.qty || 1); i++) {
        flat.push({ ...it, instanceId: it.id + '-' + i });
      }
    }
    // 按体积降序
    flat.sort((a, b) => (b.l * b.w * b.h) - (a.l * a.w * a.h));
    const placed = [];
    const unplaced = [];
    for (const f of flat) {
      const item = this.tryPlace(f);
      if (item) {
        this.place(item);
        placed.push({ ...item, name: f.name, color: f.color, instanceId: f.instanceId, baseId: f.id });
      } else {
        unplaced.push(f);
      }
    }
    return { placed, unplaced };
  }
}

// 导出给 main.js（同模块环境）
window.Packer = Packer;
window.orientations = orientations;
window.orientationsOverlap = overlap;
export { Packer, orientations, overlap };
