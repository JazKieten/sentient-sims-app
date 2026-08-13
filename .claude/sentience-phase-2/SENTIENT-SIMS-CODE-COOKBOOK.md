# Sentient Sims — Code Cookbook

**Companion to `SENTIENT-SIMS-PLAYER-HANDOFF.md`.** Every query, template and snippet, ready to
copy. Everything marked ✅ was run successfully against the live game; ⚠️ marks a known failure
mode; ❌ marks something that does **not** work (documented so you don't retry it).

All Python goes through the MCP tool `mcp__sentient-sims__exec_python`, which runs on the game's
main thread. **Use `print()` — the return value of your code is discarded.**

---

## 0. MCP tools available

| Tool | Purpose |
|---|---|
| `exec_python(code)` | Run Python in the game process. Your main tool. |
| `exec_c(code, entry="run", return_type="int", args=[])` | Compile + run C inside the game. |
| `reload_module(name)` | Hot-reload a Python module by dotted name. |
| `reload_tuning(instance_id?, resource_type?, xml_path?)` | Reload interaction/buff/trait tuning. |
| `restart_game(timeout=180, launch_cmd?)` | Kill + relaunch the game, wait for dev server. |

⚠️ **`exec_python` frequently times out on long `time.sleep()` calls** ("Error contacting dev
server ... timed out"). **The code still ran.** Re-query state in a fresh call; never re-fire the
action. Keep sleeps ≤ ~45s and split waiting into separate calls.

---

## 1. Constants for the current save

```python
# Household "Chatman, House, & Flores"
ELLIOT = 474873505018025949      # ⚠️ TWO Elliots exist; Boswell is 1014179486574065655
ADRIAN = 474873505021827065
JAKE   = 474873505103353873

LILLIE = 800258395381303561
CANDY  = 474873505008914710
PAOLO  = 474873505008914963
EVA    = 474873505008914960
JADE   = 474873505008914961
KAYLEE = 392682821524131776      # zone_id 0 — spawning NPC, no home lot
JOAQUIN= 474873505008914008

HOME   = 474873505008914964
DISCO  = 474873505008846822      # Discotheque Pan Europa
BLUE_VELVET = 1070474372335341717
CANDY_HOUSE = 474873505008914544
PAOLO_HOUSE = 474873505008914711
ALPHA_SQUAD = 392682821546480781
```

---

## 2. State reading

### 2.1 Full status board for the household ✅

```python
import services
sm = services.sim_info_manager()
print('time', services.time_service().sim_now, '| zone', services.current_zone().id)
print('funds', sm.get(ELLIOT).household.funds.money)
for name, sid in [('Elliot',ELLIOT),('Adrian',ADRIAN),('Jake',JAKE)]:
    si = sm.get(sid); sim = si.get_sim_instance()
    lows = []
    for s in si.commodity_tracker:
        n = getattr(type(s),'__name__','')
        if n.startswith('motive_') and s.get_value() < 30:
            lows.append('%s=%d' % (n[7:], s.get_value()))
    wt = si.whim_tracker
    print()
    print(name, si.get_mood().__name__, '|', lows or 'needs OK')
    print('   wants:', [getattr(s.whim,'__name__','?') for s in wt.slots_gen() if s.whim] if wt else [])
    print('   doing:', [i.affordance.__name__ for i in sim.si_state][:3] if sim else 'NOT INSTANCED')
    print('   queue:', [i.affordance.__name__ for i in sim.queue][:3] if sim else '')
```

### 2.2 Individual reads ✅

```python
si.get_mood().__name__                                   # 'Mood_Happy'
sim.is_on_active_lot()
(a.position - b.position).magnitude()                    # metres
si.zone_id
str(si.age).split('.')[-1]                               # 'YOUNGADULT'
si.household.funds.money
```

### 2.3 Buffs ⚠️

```python
# ❌ WRONG — every entry prints as 'Buff'
[type(b).__name__ for b in si.Buffs]

# ✅ RIGHT
sorted({getattr(b, 'buff_type', type(b)).__name__ for b in si.Buffs})
```
Useful greps on that set: `'Nudity'`, `'Embarrass'`, `'Tense'`, `'Uncomf'`, `'Death'`,
`'Utilit'`, `'Hygiene'`.

### 2.4 Skills ✅

```python
for s in si.commodity_tracker:
    n = getattr(type(s), '__name__', '')
    if n.startswith('statistic_Skill') and s.get_user_value() > 0:
        print(n.replace('statistic_Skill_Adult',''), round(s.get_user_value(),1))

# named skill, level AND raw points (raw is how you see progress inside a level)
ch_lvl = next(s.get_user_value() for s in si.commodity_tracker
              if getattr(type(s),'__name__','')=='statistic_Skill_AdultMajor_Charisma')
ch_raw = next(s.get_value() for s in si.commodity_tracker
              if getattr(type(s),'__name__','')=='statistic_Skill_AdultMajor_Charisma')
```

### 2.5 Wants / fears ✅ — READ LIVE EVERY TIME

```python
wt = si.whim_tracker                       # None for unplayed NPCs
if wt:
    print([getattr(s.whim, '__name__', '?') for s in wt.slots_gen() if s.whim])
```
❌ `si.current_whims` returns protobuf `WhimGoal`s whose `whim_guid64` does not resolve — dead end.
`WhimsTracker` also exposes `push_whimset`, `debug_activate_whim`, `debug_offer_whim_from_whimset`.

### 2.6 Aspirations ✅

```python
at = si.aspiration_tracker
done = set(at._completed_objectives or ())
print('TRACK:', at.active_track.__name__)
for lvl, milestone in at.active_track.get_aspirations():
    for obj in milestone.objectives:
        t = getattr(obj, 'objective_test', None)
        extra = ''
        for a in ('threshold','stat','affordances','tags','num_relations','relationship_bits'):
            v = getattr(t, a, None)
            if v not in (None, ()):
                extra += ' %s=%s' % (a, str(getattr(v,'__name__',v))[:60])
        print('   ', 'DONE' if obj in done else ' ·  ', obj.__name__, type(t).__name__, extra)
```
Test types: `StatThresholdTest`, `RelationshipTest` (`num_relations`, counts **friends** not
acquaintances), `TotalRelationshipBitTest`, `ParticipantRanInteractionTest`,
`TotalSimoleonsEarnedByTagTest`, `EventRanSuccessfullyTest`, `TimeInClubGatheringsTest`,
`SkillTagThresholdTest`, `TotalTimeElapsedByTagTest`, `ClubTest`, `PurchasePerkTest`.

### 2.7 Careers ✅

```python
for c in si.career_tracker.careers.values():
    print(type(c).__name__, 'lvl', c.user_level, 'perf', round(c.work_performance,1),
          'at_work', c.currently_at_work)
    print('  next work:', c.get_next_work_time())      # (TimeSpan, DateAndTime start, DateAndTime end)
    print('  shift:', c._current_work_start, c._current_work_end)
```
❌ `c.is_work_scheduled()` does not exist.

### 2.8 Relationships ✅

```python
from sims4.resources import Types
stm = services.get_instance_manager(Types.STATISTIC)
ft = next(t for t in stm.types.values() if t.__name__ == 'LTR_Friendship_Main')
rt = next(t for t in stm.types.values() if t.__name__ == 'LTR_Romance_Main')

tr = si.relationship_tracker
tr.get_relationship_score(other_id, ft)
tr.get_relationship_score(other_id, rt)
[str(getattr(b, '__name__', '')) for b in tr.get_all_bits(other_id)]
```
⚠️ Track names are `LTR_Friendship_Main` / `LTR_Romance_Main`. ❌ `relationshipTrack_Friendship_LTR`
does not exist. ❌ `tr._find_relationship()` does not exist. ❌ There is no `sentiment_tracker` in
this build.
⚠️ Bit `__name__` can be a **class**, not a str — wrap in `str()` before calling `.lower()`.

### 2.9 Relationship matrix (lore mining) ✅

```python
CAST = {'Elliot':ELLIOT,'Adrian':ADRIAN,'Jake':JAKE,'Lillie':LILLIE,'Candy':CANDY,'Paolo':PAOLO}
for a in ('Elliot','Adrian','Jake'):
    A = sm.get(CAST[a]); tr = A.relationship_tracker
    for b, bid in CAST.items():
        if a == b: continue
        f = round(tr.get_relationship_score(bid, ft),1)
        r = round(tr.get_relationship_score(bid, rt),1)
        bits = [str(getattr(x,'__name__','')) for x in tr.get_all_bits(bid)]
        juicy = [x for x in bits if any(k in x for k in
                 ('NoLonger','Romantic','HaveBeen','Awkward','Cheat','Enemy','Unfaithful','healed'))]
        if f or r or juicy:
            print('%-7s -> %-7s F%6.1f R%6.1f  %s' % (a, b, f, r, juicy))
```

### 2.10 Full social roster (find real sims to name in prompts) ✅

```python
for other in sm.get_all():
    if other.sim_id == si.sim_id: continue
    bits = [str(getattr(b,'__name__','')) for b in tr.get_all_bits(other.sim_id)]
    tier = [b for b in bits if b.startswith('friendship-') or b.startswith('romantic')]
    if tier:
        print(other.first_name, other.last_name, tier,
              round(tr.get_relationship_score(other.sim_id, ft),1))
```

### 2.11 Who is physically nearby ✅

```python
me = sm.get(ELLIOT).get_sim_instance()
for s in sm.instanced_sims_gen():
    inf = s.sim_info
    if inf.sim_id == me.sim_id: continue
    d = (s.position - me.position).magnitude()
    if d < 30:
        bits = [str(getattr(b,'__name__','')) for b in tr.get_all_bits(inf.sim_id)]
        print('%5.1fm %-22s %-11s on_lot=%s %s' % (
            d, inf.first_name+' '+inf.last_name, str(inf.age).split('.')[-1],
            s.is_on_active_lot(), 'met' if 'has_met' in bits else 'STRANGER'))
```
⚠️ `instanced_sims_gen()` covers the **whole zone/neighbourhood** — sims 50m+ away on other lots
come back instanced. Always check `is_on_active_lot()` AND distance before staging a scene.

### 2.12 Traits ✅

```python
tn = sorted(t.__name__ for t in si.trait_tracker)
print('PREFERENCES:', [t for t in tn if 'Preference' in t])
print('PERSONALITY:', [t for t in tn if 'Preference' not in t and 'Hidden' not in t])
print('DISLIKES:',    [t.split('_')[-1] for t in tn if 'Dislikes' in t])
```

---

## 3. App HTTP API (port 25148)

### 3.1 Enqueue an action ✅ — the primary control path

```python
import json, urllib.request

def enq(sim_id, action, motivation, target=None, obj=None, clear=False, priority='high'):
    body = {'sim_id': str(sim_id), 'action': action, 'priority': priority,
            'insert_strategy': 'next', 'clear_queue': clear,
            'source': 'claude', 'motivation': motivation}
    if target: body['target_sim_id'] = str(target)
    if obj:    body['target_object_id'] = str(obj)
    req = urllib.request.Request('http://127.0.0.1:25148/cognition/debug/enqueue',
        data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    return urllib.request.urlopen(req, timeout=10).read().decode()   # {"request_id": "..."}
```

**The 27 whitelisted actions** (`src/sentient_sims_code/interactions/ss_affordance_whitelist.py`):
```
chat · ask_about_day · ask_about_career · get_to_know · deep_conversation · compliment_outfit
gossip · apologize · tell_joke · tell_funny_story · hug · flirt · kiss · insult
grab_snack · cook_meal · sleep · nap · take_shower · use_toilet · brush_teeth
sit · watch_tv · read_book · browse_web · play_piano · dance
```

Inspect an entry's underlying affordance/mixer:
```python
import inspect, sentient_sims_code.interactions.ss_affordance_whitelist as WL
src = inspect.getsource(WL)
i = src.find("'flirt'"); print(src[i:i+220])
# -> {'affordance': SOCIAL_SUPER, 'mixer': 'mixer_social_Flirt_targeted_romance_alwaysOn', ...}
```

**Standard needs-recovery batch** (order matters — bladder, then food, then sleep):
```python
for sid in (ELLIOT, ADRIAN, JAKE):
    enq(sid, 'use_toilet', "Home at dawn after a full night out", clear=True)
    enq(sid, 'grab_snack', "Nobody ate all night")
    enq(sid, 'sleep',      "They earned this")
```
⚠️ **Hygiene before sleep, always** — I queued `sleep` before `take_shower` and a sim hit
`sim_HygieneFailure` at Hygiene −100.
⚠️ `dance` fails in clubs: `no object on the lot provides 'stereo_Dance'` — clubs use DJ booths.
Push `generic_Dance` as a raw affordance instead.

### 3.2 Read the story back ✅ — do this after every scene

```python
import json, urllib.request
r = urllib.request.urlopen('http://127.0.0.1:25148/memories', timeout=10)
for m in json.loads(r.read().decode())[-6:]:
    print('#', m.get('id'), '|', (m.get('pre_action') or '')[:100].replace('\n',' '))
    print('   ', (m.get('content') or '').replace('\n',' ')[:420])
```

### 3.3 Other endpoints ✅

```python
urllib.request.urlopen('http://127.0.0.1:25148/debug/health', timeout=5).read()
urllib.request.urlopen('http://127.0.0.1:25148/participants', timeout=10).read()      # bios
urllib.request.urlopen('http://127.0.0.1:25148/websocket/isconnected', timeout=5).read()
# POST /participants/:id           update a bio
# POST /cognition/perception       a sim's own view of the world
# POST /cognition/sleep-boundary
# DELETE /memories/:id
```

---

## 4. Dialogue

### 4.1 Directed scene ✅ — best attribution, use this for real dialogue

```python
import services, json, urllib.request
from sentient_sims_code.sentient_sim_builder import SentientSimBuilder
from sentient_sims_code.ss_environment_builder import SSEnvironmentBuilder
from sentient_sims_code.relationships.ss_relationships_util import SSRelationshipsUtil
from sentient_sims_code.events.interaction_v2_event import InteractionV2Event
from sentient_sims_code.ss_config import SSConfig

def directed_scene(id_a, id_b, direction, continue_scene=False):
    sm = services.sim_info_manager()
    a = sm.get(id_a).get_sim_instance()
    b = sm.get(id_b).get_sim_instance()
    if a is None or b is None: return 'ABORT: not instanced'
    d = (a.position - b.position).magnitude()
    if d > 12.0: return 'ABORT: %.1fm apart' % d
    sims = [SentientSimBuilder(a).build(), SentientSimBuilder(b).build()]
    ev = InteractionV2Event(
        interaction_name='directed_scene',                 # ⚠️ REQUIRED
        environment=SSEnvironmentBuilder().build(),
        relationships=SSRelationshipsUtil.get_relationships(sims),
        sentient_sims=sims)
    evd = ev.to_dict()
    evd['testing_action'] = direction                      # ⚠️ MUST be testing_action
    payload = {'event': evd, 'continueScene': bool(continue_scene)}
    req = urllib.request.Request(SSConfig().server_url() + '/ai/v2/event/directed-scene',
        data=json.dumps(payload).encode(), headers={'Content-Type':'application/json'})
    return urllib.request.urlopen(req, timeout=30).read().decode()[:120]
```

Server-side gate — both conditions must pass or it silently NOOPs:
```ts
if ((!event.testing_action && !request.continueScene) || event.sentient_sims.length < 2) return NOOP;
```

### 4.2 In-their-head voice ✅

```python
import services
from sentient_sims_code.sentient_sim_builder import SentientSimBuilder
from sentient_sims_code.ss_environment_builder import SSEnvironmentBuilder
from sentient_sims_code.relationships.ss_relationships_util import SSRelationshipsUtil
from sentient_sims_code.events.do_something_interaction_event import DoSomethingInteractionEvent
from sentient_sims_code.ss_interaction_service import SSInteractionService

def voice(id_a, text, id_b=None):
    sm = services.sim_info_manager()
    insts = [sm.get(id_a).get_sim_instance()]                  # ⚠️ INSTANCE not SimInfo
    if id_b: insts.append(sm.get(id_b).get_sim_instance())
    if any(i is None for i in insts): return 'ABORT: not instanced'
    sims = [SentientSimBuilder(i).build() for i in insts]
    svc = SSInteractionService(); svc.clear_queue()
    svc.add_task_no_wait(DoSomethingInteractionEvent(
        environment=SSEnvironmentBuilder().build(),
        relationships=SSRelationshipsUtil.get_relationships(sims),
        sentient_sims=sims, action=text))
    return 'sent'
```

⚠️ **Module paths** — these are NOT under `models/`:
```python
sentient_sims_code.sentient_sim_builder            # ❌ NOT .models.sentient_sim_builder
sentient_sims_code.ss_environment_builder          # ❌ NOT .models.ss_environment_builder
sentient_sims_code.relationships.ss_relationships_util
```
⚠️ Passing a **SimInfo** instead of a Sim instance throws
`AttributeError: 'SimInfo' object has no attribute 'posture'`.
⚠️ **Always pass a second sim** — solo → `speaker: 'Narrator'` → sim loses their TTS voice.

### 4.3 Multi-speaker prompt template ✅

Both/all sims in the event always get a generated line. Direct each one explicitly or the
undirected sim will finish the other's sentence under the wrong name and voice.

```
TWO SPEAKERS, each gets their own separate line, neither speaks for the other.
<NAME A> says, in two sentences maximum: <what A conveys>.
<NAME B> says, in one or two sentences of his own words: <what B conveys>.
<NAME B> must not continue <NAME A>'s sentence - he replies as himself.
```

### 4.4 Subtitle / websocket taps ✅

```python
# UI tap — what actually reached the subtitle overlay
from sentient_sims_code.ss_ui import SSUi
import sentient_sims_code.ss_ui as ssui_mod, time
if not hasattr(ssui_mod, '_claude_tap_installed'):
    ssui_mod._claude_log = []
    ssui_mod._claude_orig_send = (SSUi.send_ui_event.__func__
        if hasattr(SSUi.send_ui_event,'__func__') else SSUi.send_ui_event)
    def tapped(event_name, data=None, *a, **kw):
        try:
            if event_name == 'new_sentient_memory' and isinstance(data, dict):
                c = data.get('content')
                if c:
                    ssui_mod._claude_log.append((time.strftime('%H:%M:%S'), c))
                    if len(ssui_mod._claude_log) > 120: del ssui_mod._claude_log[:40]
        except Exception: pass
        return ssui_mod._claude_orig_send(event_name, data, *a, **kw)
    SSUi.send_ui_event = staticmethod(tapped)
    ssui_mod._claude_tap_installed = True

# read
for t, c in ssui_mod._claude_log[-5:]: print(t, '|', c)

# websocket tap (records `paced` flag + speaker)
import sentient_sims_code.ss_memories_service as MS
for e in MS._claude_ws_log[-6:]:
    print({k: str(v)[:200] for k, v in e.items()})
```
Entries look like `{'type':'scene_line','speaker':'Elliot Chatman','head':'...'}` and
`{'type':'memory_created','paced':'True','len':'204','head':'...'}`.
`paced: False` = dumped silently as one blob (WickedWhims scenes always are).
`SUBTITLE_MAX_CHARS = 200`; 30s dedupe window drops identical repeats.

---

## 5. Pushing raw affordances

### 5.1 The push helper ✅

```python
import services, interactions.priority, interactions.aop
from interactions.context import InteractionContext, InteractionSource, QueueInsertStrategy
from sims4.resources import Types

def push(sim, affordance_name, target=None, priority='critical', insert='next'):
    mgr = services.get_instance_manager(Types.INTERACTION)
    aff = next((t for t in mgr.types.values() if t.__name__ == affordance_name), None)
    if aff is None: return 'no such affordance: ' + affordance_name
    prio = {'critical': interactions.priority.Priority.Critical,
            'high':     interactions.priority.Priority.High,
            'low':      interactions.priority.Priority.Low}[priority]
    ins = QueueInsertStrategy.NEXT if insert == 'next' else QueueInsertStrategy.LAST
    ctx = InteractionContext(sim, InteractionSource.PIE_MENU, prio, insert_strategy=ins)
    return interactions.aop.AffordanceObjectPair(aff, target, aff, None).test_and_execute(ctx)
```
**Use Critical** — the mod's own `push_affordance` only exposes Low/High and High loses to
autonomy. Look for `(guaranteed)` in the result string.
For a self-targeted social/solo action, pass the sim itself as `target`.

### 5.2 Find affordances ✅

```python
mgr = services.get_instance_manager(Types.INTERACTION)
sorted(t.__name__ for t in mgr.types.values() if 'keyword' in t.__name__.lower())
```

### 5.3 Cancel what a sim is doing ✅

```python
from interactions.interaction_finisher import FinishingType
for i in list(sim.si_state) + list(sim.queue):
    i.cancel(FinishingType.USER_CANCEL, 'claude: reason shown in logs')
```
⚠️ `i.cancel(None, ...)` silently does nothing — you must pass a real `FinishingType`.
⚠️⚠️ **Cancelling resets any in-progress walk.** See §5.5.

### 5.4 Mixers ✅

```python
from sentient_sims_code.interactions.ss_interaction_push import push_mixer, find_staged_si
si = next((i for i in sim.si_state if i.affordance.__name__ == 'sim_Chat'), None)
if si: push_mixer(sim, si, mixer_affordance, target_sim)
```
⚠️ A mixer pushed standalone fails: `No Sim specified in context`. It needs a live parent social SI.

### 5.5 ⚠️⚠️ WAIT FOR THEM TO WALK — the #1 mistake

```python
# after pushing, DON'T cancel-and-repush. Check the queue:
print('queue:', [i.affordance.__name__ for i in sim.queue])
print('dist:  %.1f' % (sim.position - target.position).magnitude())
# affordance still in queue == it is WORKING, the sim is en route.
# budget ~1s real time per metre. Only intervene if it LEFT the queue without
# running, or 'route-fail' appears in si_state/queue.
```
A 50m route across a two-floor club took ~45s. Three cancel-and-repush "fixes" restarted it each
time and it never completed.

### 5.6 Verified affordance names ✅

```
# needs / household
bed_sleep · bed_Nap · sofa_Nap · toilet-use-standing · toilet-use-sitting
  ⚠️ toilet-use-sitting is trait-gated: "Actor doesn't have any or enough traits in white list"
     → use toilet-use-standing for male sims
fridge_GrabLunchAutonomously · phone_HirePizzaDelivery · Collect_Dish
mailbox_PayBills · computer_PayBills · phone_PayBills · tablet_PayBills
object_Hire_Repair_Service · phone_HireRepair · fire_CallFirefighter · fire_ReplaceBurntObject
dresser_ChangeSim ⚠️ opens a UI picker that needs a real player click — does nothing headless

# social
sim_InviteIn · sim_InviteIn_NoSummon · sim-gohome · immediate_Introduction_MakeHasMetInSocialGroup
mixer_social_FriendlyIntroduction_greetings · mixer_social_FunnyIntroduction_greetings
mixer_social_BroHug_targeted_Friendly_alwaysOn · mixer_social_Flirt_targeted_romance_alwaysOn
si_touching_Greeting_Hug_Bro · si_touching_Greeting_EuroKiss

# skills / creative
mirror_PracticeSpeech_Autonomous · mirror_PracticeSpeech1..6 · mirror_PracticeFlirty1..6
easel_Craft_Autonomously · Easel_Canvas_Paint_Passive/Small/Medium/Large
canvas_MoveToInventory · canvas_SellObject ⚠️ needs CanvasSalability_Gallery, fails on Normal
guitar_Practice · guitar_Play_Song · piano_StartWriting · violin_StartWriting
computer_StartWriting · Computer_Write_Keyboard
  ⚠️ computer_CreateBook is a crafting PHASE: "missing 2 required keyword-only arguments:
     'crafting_process' and 'phase'" — use computer_StartWriting as the entry point
DJBooth_PlayMusic_genre_05_Breakbeats · DJBooth_PlayMusic_genre_02_Machine_hiSkill
DJBooth_PlayMusic_genre_00_Practice_level01..09 · mixer_DJBooth_GiveTipToPlayer
generic_Dance · stereo_TurnOnAndListen · bar_OrderDrink · bar_OrderRound · bar_Order_Food

# infants (all intent-carrying — prefer these over generic pickup + action)
socialSuperInteraction_CarryPickUp_Infant_ToBatheBubbles      # THE reliable bath route
socialSuperInteraction_CarryPickUp_Infant_ToHighChair
socialSuperInteraction_CarryPickUp_Infant_ToBirthdayCake_AgeUp
putDown_CarriedSim_Crib_Infant_ToSleep · baby_ChangeDiaper
fridge_BakeCake_Autonomously · BirthdayCake_AddCandles · crib_Upgrade_ConvertToBed
```

---

## 6. Objects

### 6.1 Scan the lot ✅

```python
import services
om = services.object_manager()
for o in om.get_all():
    if not o.is_on_active_lot(): continue        # ⚠️ ALWAYS FILTER — get_all() is the whole zone
    print(type(o).__name__, 'in_use', o.in_use)
```
⚠️ `d.name` on a definition is usually `None` — identify objects by `type(o).__name__`.

### 6.2 Broken/dirty sweep ✅ — run every in-game morning

```python
for o in om.get_all():
    if not o.is_on_active_lot(): continue
    sc = getattr(o, 'state_component', None)
    if not sc: continue
    for st, v in (sc._states or {}).items():
        vn = getattr(v, '__name__', str(v))
        if ('Broken' in vn and 'Unbroken' not in vn) or vn == 'Dirty_Dirty' or 'Clog' in vn:
            print(type(o).__name__, '->', vn)
```
Values seen: `Brokenness_Broken` / `Brokenness_Unbroken`, `BrokenState_Broken`,
`Dirty_Dirty` / `Dirty_Clean`, `utilities_Water_Consumption_Off` ← **that one means unpaid bills**.

⚠️ Burnt-object filter gotcha: healthy value `FireState_Burn_Material_Change_Not_Burning`
*contains* burnt value `FireState_Burn_Material_Change`. Exclude `'Not_Burning' in vn`.

### 6.3 Find & buy a definition ✅

```python
defmgr = services.definition_manager()          # ❌ .get_all_definitions() does not exist
cands = []
for d in defmgr.loaded_definitions:
    cls = getattr(d, 'cls', None)
    n = getattr(cls, '__name__', '') if cls else ''
    if 'guitar' in n.lower() and getattr(d, 'price', 0):
        cands.append((d.price, n, d.id))
for row in sorted(set(cands))[:12]: print(row)
```
IDs used: `object_musicGuitarGEN_01` 27232 §600 · `object_toiletC_02` 15829 §250 ·
`object_Crib_EF48GEN` 293880.

### 6.4 Place an object ⚠️ HIGH RISK

```python
import objects.system, sims4.math
ref = <a nearby object already correctly placed indoors>
obj = objects.system.create_object(DEF_ID)
obj.location = ref.location                     # inherits level + routing surface
obj.set_location(obj.location.clone(
    translation=sims4.math.Vector3(ref.position.x + dx, ref.position.y, ref.position.z + dz)))
print(obj.is_on_active_lot(), obj.is_outside, obj.position)
```
⚠️⚠️ **`is_outside == False` DOES NOT mean "inside the room."** A §250 toilet placed at
`x + 1.2` in a small bathroom passed `is_on_active_lot()`, `is_outside == False`, and matching
floor height — and was sitting **on top of the exterior wall**, unreachable. Even
`test_and_execute` on its use-affordance returned success. Only a **screenshot** revealed it.
- Compare the **room id** and `level` to the reference object, not just height.
- **Ask Jazki to place anything that must fit a tight interior** — he can see it.
- `services.current_zone().lot.center` returns **terrain** height (a metre below interior floors).
- Offsetting from the **mailbox** puts things in the street.

### 6.5 Money ✅ — ALWAYS TAKE IT

```python
from sims.funds import FundsSource
household.funds.try_remove(price, FundsSource.HOUSEHOLD, sim=some_sim_instance)
household.funds.add(price, FundsSource.HOUSEHOLD)        # refund
```
⚠️ `try_remove(price, reason=None, sim=...)` moves the funds then raises
`TypeError: None has type NoneType, but expected one of: int, long` inside the protobuf UI update.
**The money already moved** — re-read `funds.money` instead of assuming failure.

### 6.6 Remove an object ✅

```python
obj.destroy(source=None, cause='claude: bad placement, refunding')
```

### 6.7 Crafting stations — the occupied-slot trap ✅

```python
easel = next(o for o in om.get_all()
             if type(o).__name__ == 'object_paintEaselGEN_01' and o.is_on_active_lot())
kids = list(easel.children_recursive_gen())
if kids:
    canvas = kids[0]
    cc = canvas.crafting_component
    print(type(canvas).__name__, 'complete:', cc._crafting_process.is_complete,
          'value:', canvas.current_value)
    # finished work blocks the slot → move it off first
    push(sim, 'canvas_MoveToInventory', canvas)
push(sim, 'easel_Craft_Autonomously', easel)     # now (guaranteed)
```
Symptom without this: `SlotTest: participant doesn't meet slot availability requirements`.
Also check the sim isn't holding something (`carry_holdobject` in `si_state`).

### 6.8 Sim inventory ✅

```python
[type(o).__name__ for o in sim.inventory_component]
```
❌ There is **no** sell-from-inventory interaction — it's a UI-only drag action. Ask Jazki.

---

## 7. Bills ✅

```python
bm = household.bills_manager
print('owed:', bm.current_payment_owed)          # None when clear (NOT 0)
print('cut off:', bm._utility_delinquency)       # {POWER: True/False, WATER: True/False}
print('autopay:', bm.autopay_bills)              # False by default; reward unlock, leave alone
print('housing/other:', bm._housing_costs_owed, bm._non_housing_costs_owed)
# DELINQUENCY_FREQUENCY = 48 (hours from arrival to shutoff)
```
Fix — walk a sim to the mailbox:
```python
box = next(o for o in om.get_all() if type(o).__name__=='object_Mailbox' and o.is_on_active_lot())
push(sim, 'mailbox_PayBills', box)
```
❌ Never `bills_manager.pay_bill()` — banned direct-API path.

---

## 8. Situations

### 8.1 Throw a party ✅

```python
import services
from sims4.resources import Types
from situations.situation_guest_list import (SituationGuestList, SituationGuestInfo,
                                             SituationInvitationPurpose)
mgr = services.get_instance_manager(Types.SITUATION)
SIT = next(t for t in mgr.types.values() if t.__name__ == 'Situation_HouseParty')
jobs = {j.__name__: j for j in SIT.get_tuned_jobs()}
# job_party_host · job_guest_party · job_bartender · job_caterer · job_entertainer_birthday_party
gl = SituationGuestList(invite_only=True, host_sim_id=HOST)
gl.add_guest_info(SituationGuestInfo.construct_from_purpose(
    HOST, jobs['job_party_host'], SituationInvitationPurpose.INVITED))
for sid in [ELLIOT, ADRIAN, LILLIE, PAOLO, CANDY]:
    gl.add_guest_info(SituationGuestInfo.construct_from_purpose(
        sid, jobs['job_guest_party'], SituationInvitationPurpose.INVITED))
sit_id = services.get_zone_situation_manager().create_situation(SIT, guest_list=gl, user_facing=True)
```
⚠️ `SituationInvitationPurpose` is in `situations.situation_guest_list`, ❌ **not**
`situations.situation_types`.
Other situations: `Situation_DinnerParty`, `Situation_CostumeParty`, `Situation_BlackAndWhiteParty`,
`situation_birthday_party`, `situation_GreetedNPCVisitingPlayerSituation_2h`.

### 8.2 READ AND DRIVE THE GOALS ✅ — otherwise it finishes at TIN (a fail)

```python
party = services.get_zone_situation_manager().get(sit_id)
print('MEDAL:', party.get_level())               # SituationMedal.TIN/BRONZE/SILVER/GOLD
for g in party.get_active_goals() or ():
    print(type(g).__name__, getattr(g,'_iterations',None), '/', getattr(g,'max_iterations',None))
    for a in ('tags','affordances','participant_type'):
        v = getattr(g, a, None)
        if v: print('   ', a, str(v)[:160])
```
A house party wanted: 12 × `Tag.Interaction_Chat`, 2 × comedy mixers, 4 × `generic_consume_food`,
3 sims in `Tag.Interaction_PlayGame`.

### 8.3 List live situations ✅

```python
for s in services.get_zone_situation_manager().get_all():
    print(type(s).__name__)
# situation_welcomeWagon, situation_Walkby_Neighbor, situation_leave, ...
```

### 8.4 Clubs ✅

```python
cs = services.get_club_service()
club = cs.get_club_by_id(ALPHA_SQUAD)
print(club.leader.first_name, [m.first_name for m in club.members])
print('gathering?', cs.clubs_to_gatherings_map.get(club))
cs.start_gathering(club, start_source=..., host_sim_id=0, invited_sims=(), zone_id=...)
```

### 8.5 Bring an off-lot sim over ✅

```python
services.get_zone_situation_manager().create_greeted_npc_visiting_npc_situation(sim_info)
```
❌ Failed alternatives: `SimSpawner.spawn_sim` (returns True, never instances),
`SimSpawner.load_sim`, `SimSpawnerService.submit_request`, `summon_sim_to_zone`.
Summoned NPCs despawn on their own — re-summon before any scene needing them.

---

## 9. Travel & clock ✅

```python
import services, world.travel_service
world.travel_service.travel_sims_to_zone([ELLIOT, ADRIAN, JAKE], DISCO)
# ~15-25 real seconds, then verify:
print(services.current_zone().id)

from clock import ClockSpeedMode
services.game_clock_service().set_clock_speed(ClockSpeedMode.NORMAL)   # SPEED2 / SPEED3 / PAUSED
print(services.time_service().sim_now, services.game_clock_service().clock_speed)
```
⚠️ During a load screen `services.current_zone()` is **None** and every other service throws
`'NoneType' object has no attribute ...`. Poll until it returns:
```python
import time
for _ in range(10):
    z = services.current_zone()
    if z is not None: print('back:', z.id); break
    time.sleep(5)
```
⚠️ `sim-gohome` refuses with *"Selectable Sims cannot go home if they are already at home"* when
the sim is in the home zone but standing up the street. Push an interaction on an object **inside**
the house instead and let them walk.

Zone/world names:
```python
ps = services.get_persistence_service()
zd = ps.get_zone_proto_buff(services.current_zone().id)
nd = ps.get_neighborhood_proto_buff(zd.neighborhood_id)
print(zd.name, '|', nd.name, '| venue:', type(services.venue_service().active_venue).__name__)
```

---

## 10. WickedWhims ✅

```python
# stop an active scene properly (cancelling the SI re-adds it)
import wickedwhims.sex.integral.sex_handlers.active_sex.active_sex_handlers as ah
for inst in list(ah.get_active_sex_instances()): inst.stop()
```
Pushes during a scene fail with `canceled (Subject is in sex.)`.
Useful WW data: `WickedWhims_Trait_Personality_Archetype_Jester_Major` / `Artist_Minor`,
`RelBit_Attractiveness_Visual_High/Medium/Low`, `Buff_Nudity_Pressure_MaxEmbarrassed`.
⚠️ `WickedWhims_Nudity_ForceDressUp` / `_DressUp` / `_Put_On_Underwear` all failed their tests;
`Debug_Nudity_FixNudityAndOutfits` ran but changed nothing. **A plain shower cleared it.**

---

## 11. Creating and moving sims ✅

```python
from sims.sim_spawner import SimSpawner, SimCreator
from sims.sim_info_types import Age, Gender, Species
client = services.client_manager().get_first_client()
hh = services.household_manager().create_household(client.account)     # ❌ not add_household
hh.name = 'Reid'
out = SimSpawner.create_sim_infos(
    (SimCreator(gender=Gender.FEMALE, age=Age.ADULT, species=Species.HUMAN,
                first_name='Eleanor', last_name='Reid'),),
    household=hh, generate_deterministic_sim=True, zone_id=services.current_zone_id())
sim_info = list(out[0])[0]                                             # returns (infos, household)

services.household_manager().switch_sim_from_household_to_target_household(
    sim_info, source_hh, dest_hh, destroy_if_empty_household=False)
```
Traits by class: `services.get_instance_manager(sims4.resources.Types.TRAIT).types`.

---

## 12. `exec_c` — running C in the game

Not needed for roleplay; included for completeness. Auto-detects the toolchain
(WSL2/Linux→Windows `x86_64-w64-mingw32-gcc`, Windows `gcc`, macOS `clang -arch arm64`), compiles
to a fresh temp DLL per call, loads with `ctypes.CDLL`, calls `entry`, marshals the result to JSON.

```c
__declspec(dllexport) int run(int a, int b) { return a + b; }
```
```
exec_c(code=<above>, entry="run", return_type="int", args=[2, 3])
# -> {"result": 5, "lib": "C:\\Users\\...\\Temp\\ss_c_<uuid>.dll"}
```
`return_type`: `int · int32 · int64 · long · double · float · string · void`.
Args map: int→int64, float→double, str→`const char*` (UTF-8), bool→int.
Export with `__declspec(dllexport)` on Windows; default visibility already exports on macOS/Linux.
Toolchains: `sudo apt install mingw-w64` (WSL2) · MSYS2 + mingw-w64-x86_64-gcc (Windows) ·
`xcode-select --install` (macOS).

---

## 13. Hot-reloading mod code

```
reload_module("sentient_sims_code.ss_service")     # services/listeners/utils/wrappers
reload_tuning()                                    # all embedded interaction tunings
reload_tuning(instance_id="123456")                # one embedded interaction
reload_tuning(instance_id="123456", resource_type="BUFF")     # .package tuning
restart_game(timeout=180)
```
⚠️ Reloading a module alone will **not** re-register an interaction tuning with the
InstanceManager or re-add it to pie menus — use `reload_tuning` for those.
⚠️ Read the `tuning-system` skill before touching `interactions/` or `tuning/` source.

---

## 14. Threading note

Older notes say every engine-touching call must be marshalled:
```python
from sentient_sims_code import ss_game_thread
ss_game_thread.run(lambda: push_affordance(...))
```
**In this session, direct `test_and_execute` from `exec_python` worked fine** — `exec_python`
already runs on the game's main thread. The one crash seen was
`AttributeError: 'NoneType' object has no attribute 'run_child'` deep in the posture graph
(`canvas_MoveToInventory` while the sim was in a bad posture) — and **the interaction still
completed**. If you hit that error, re-read state before retrying; it may already have worked.

Results cannot be returned from an `ss_game_thread.run` callback — stash on a module attribute and
read it next call. Build log strings with `+ str(x)`, not `"%r" % x` (EnqueueResult breaks `%`).

---

## 15. Index of failure messages → cause

| Message | Cause / fix |
|---|---|
| `Missing relationship bit () between and .` | Strangers. Only `chat` works first — it introduces. |
| `Subject is in sex.` | WickedWhims scene active. Stand down. |
| `SlotTest: participant doesn't meet slot availability requirements` | Finished craft occupying the slot, or sim's hands full. §6.7 |
| `Actor doesn't have any or enough traits in white list` | Wrong variant — e.g. `toilet-use-sitting` vs `-standing`. |
| `no object on the lot provides 'stereo_Dance'` | Club has DJ booths, not stereos. Push `generic_Dance`. |
| `Bills: Interaction requires a utility that is shut off` | Unpaid bills. §7 |
| `Selectable Sims cannot go home if they are already at home` | Same zone, wrong spot. Push an indoor object interaction. |
| `has already hired service ServiceNpc_Repair` | One repair hire covers the whole lot. |
| `Object failed state check: CanvasSalability_Gallery` | Normal painting; sell is UI-only. |
| `missing 2 required keyword-only arguments: 'crafting_process' and 'phase'` | Crafting phase pushed directly. Use the `*_StartWriting`/`*_Craft_*` entry point. |
| `'SimInfo' object has no attribute 'posture'` | Passed SimInfo to a builder. Use `.get_sim_instance()`. |
| `'NoneType' object has no attribute 'sim_info'` | `get_sim_instance()` returned None — sim is at work/off-lot. |
| `'NoneType' object has no attribute 'time_service'` | Load screen. `current_zone()` is None; poll. |
| `Error contacting dev server ... timed out` | Long sleep. **The code ran.** Re-query. |
| `EnqueueResult: True` but nothing happens | Either still walking (§5.5) or autonomy won. Check `sim.queue` first. |
