import { describe, expect, it } from 'vitest'
import type { Maneuver } from './guidance'
import { coachStopOnSpan, type Point, type Progress, type Spans, splitRoute, splitRouteAt } from './route'
import { arrowStrips, nextRouteArrow } from './routeArrow'

const spans: Spans = [
  [
    [0, -50],
    [0, 0],
  ],
  [
    [0, 0],
    [0, 20],
    [20, 20],
  ],
  [
    [20, 20],
    [40, 20],
  ],
  [
    [40, 20],
    [40, 42],
    [20, 42],
  ],
]
const maneuvers: Maneuver[] = [
  { node: 1, turn: 'right', angle: 90, exit: null },
  { node: 3, turn: 'left', angle: -90, exit: null },
]

function progress(span: number, at: Point, index = 0, distance = 0): Progress {
  return { span, at, index, distance }
}

describe('nextRouteArrow', () => {
  it('follows the next junction and switches as the truck gets past it', () => {
    expect(nextRouteArrow(spans, maneuvers, 1, progress(0, [0, -10]), new Map())).toEqual([
      [0, 0, 0],
      [0, 20, 0],
      [20, 20, 0],
    ])
    // The truck is through the first junction, even while the next-node update is on its way.
    expect(nextRouteArrow(spans, maneuvers, 2, progress(2, [23, 20]), new Map())).toEqual([
      [40, 20, 0],
      [40, 42, 0],
      [20, 42, 0],
    ])
    expect(nextRouteArrow(spans, maneuvers, 4, progress(3, [35, 42], 1), new Map())?.[0]).toEqual([35, 42, 0])
  })

  it('keeps the first arrow up to its tip and switches before the next-node message arrives', () => {
    expect(nextRouteArrow(spans, maneuvers, 2, progress(1, [18, 20], 1), new Map())?.at(-1)).toEqual([20, 20, 0])
    expect(nextRouteArrow(spans, maneuvers, 2, progress(1, [20, 20], 1), new Map())?.at(-1)).toEqual([20, 42, 0])
  })

  it('uses the ordered occurrence at a junction visited in both directions', () => {
    const roundTrip: Spans = [
      spans[1],
      [
        [20, 20],
        [0, 20],
        [0, 0],
      ],
    ]
    const turns = [
      { ...maneuvers[0], node: 0 },
      { ...maneuvers[1], node: 1 },
    ]
    expect(nextRouteArrow(roundTrip, turns, 1, progress(0, [0, 5]), new Map())?.at(-1)).toEqual([20, 20, 0])
    expect(nextRouteArrow(roundTrip, turns, 2, progress(1, [15, 20]), new Map())?.at(-1)).toEqual([0, 0, 0])
  })

  it('stays on the bright coach leg, including when a parking bay cuts the junction span', () => {
    const { active } = splitRoute(spans, 1)
    expect(nextRouteArrow(active, maneuvers, 1, progress(0, [0, -10]), new Map())).toBeNull()
    const parking = coachStopOnSpan(spans, 1, [8, 20])!
    const trimmed = splitRouteAt(spans, parking)
    expect(nextRouteArrow(trimmed.active, maneuvers, 1, progress(0, [0, -10]), new Map())?.at(-1)).toEqual([8, 20, 0])
    expect(nextRouteArrow(trimmed.active, maneuvers, 2, progress(1, [7, 20], 1), new Map())?.at(-1)).toEqual([8, 20, 0])
    expect(nextRouteArrow(trimmed.active, maneuvers, 2, progress(1, [8, 20], 1), new Map())).toBeNull()
  })

  it('keeps the roundabout arrow near its exit and interpolates the drawn road height', () => {
    const road: Point[] = [
      [0, -90],
      [0, 0],
      [20, 0],
    ]
    const turn: Maneuver = { node: 0, turn: 'roundabout', angle: 90, exit: 2 }
    const heights = new Map<Point, number>([
      [road[0], 9],
      [road[1], 18],
      [road[2], 24],
    ])
    const arrow = nextRouteArrow([road], [turn], 1, progress(0, [0, -90]), heights)
    expect(arrow?.[0][0]).toBe(0)
    expect(arrow?.[0][1]).toBeCloseTo(-12)
    expect(arrow?.[0][2]).toBeCloseTo(16.8)
    expect(arrow?.at(-1)).toEqual([20, 0, 24])
    expect(nextRouteArrow([road], [turn], 1, progress(0, [10, 0], 1), heights)?.[0]).toEqual([10, 0, 21])
  })

  it('places the first arrow as soon as the route is ready, even from a long approach', () => {
    const far: Spans = [
      [
        [0, -2400],
        [0, 0],
      ],
      spans[1],
    ]
    expect(nextRouteArrow(far, maneuvers, 0, null, new Map())?.at(-1)).toEqual([20, 20, 0])
    expect(nextRouteArrow(far, maneuvers, 1, progress(0, [0, -2400]), new Map())?.at(-1)).toEqual([20, 20, 0])
    expect(nextRouteArrow(spans, maneuvers, 1, progress(2, [40, 20], 0, 40), new Map())?.at(-1)).toEqual([20, 20, 0])
  })
})

describe('arrowStrips', () => {
  it('covers the bright route, widens into a head, and follows the route through the bend', () => {
    const mesh = arrowStrips(
      [
        [0, 0, 3],
        [0, 20, 5],
        [20, 20, 9],
      ],
      12,
    )!
    const widths = mesh.casing.flatMap(([x, z], i) =>
      i % 2 ? [] : [Math.hypot(x - mesh.casing[i + 1][0], z - mesh.casing[i + 1][1])],
    )
    const [left, right] = mesh.fill
    expect(Math.hypot(left[0] - right[0], left[1] - right[1])).toBeCloseTo(12.6)
    const widest = Math.max(...widths)
    expect(widest).toBeCloseTo(widths[0] * 1.5)
    const base = widths.indexOf(widest) * 2
    expect((mesh.casing[base][0] + mesh.casing[base + 1][0]) / 2).toBeCloseTo(2.0072)
    expect(mesh.casing.at(-1)).toEqual([20, 20, 9])
    expect(mesh.casing.some(([x, z, height]) => x !== 0 && z !== 20 && height === 5)).toBe(true)
    expect(mesh.fill.at(-1)?.[0]).toBeLessThan(20)
  })
})
