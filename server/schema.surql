-- SurrealDB Schema for Avalon
-- Apply with: node --env-file=../.env server/apply-schema.mjs

-- ============ ACCESS ============

DEFINE ACCESS OVERWRITE user_auth ON DATABASE TYPE RECORD
  SIGNUP (
    CREATE user SET
      email = $email,
      pass = IF $pass != NONE THEN crypto::argon2::generate($pass) ELSE NONE END,
      created = time::now(),
      lastActive = time::now()
  )
  SIGNIN (
    SELECT * FROM user WHERE
      email = $email AND
      crypto::argon2::compare(pass, $pass)
  )
  DURATION FOR TOKEN 24h, FOR SESSION 7d
;

-- ============ API CONFIG ============

DEFINE CONFIG OVERWRITE API
    MIDDLEWARE
        api::timeout(10s),
        api::req::body('json'),
        api::res::body('json'),
        api::res::headers({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'POST, OPTIONS'
        });

-- ============ TABLES ============
-- Write permissions are FULL so that DEFINE FUNCTION (which runs as the caller)
-- can mutate records. Reads stay restrictive. Clients are prevented from issuing
-- arbitrary queries via SurrealDB's --deny-arbitrary-query flag.

-- user: one record per authenticated player
DEFINE TABLE OVERWRITE user SCHEMAFULL
  PERMISSIONS
    FOR select WHERE id = $auth.id
    FOR create, update, delete FULL
;
DEFINE FIELD OVERWRITE email ON user TYPE option<string>;
DEFINE FIELD OVERWRITE pass ON user TYPE option<string>;
DEFINE FIELD OVERWRITE name ON user TYPE option<string>;
DEFINE FIELD OVERWRITE lobby ON user TYPE option<string>;
DEFINE FIELD OVERWRITE lastActive ON user TYPE option<datetime>;
DEFINE FIELD OVERWRITE created ON user TYPE option<datetime>;
DEFINE FIELD OVERWRITE logs ON user TYPE option<array<record<game_log>>>;
DEFINE FIELD OVERWRITE logs.* ON user TYPE record<game_log>;
DEFINE FIELD OVERWRITE stats ON user TYPE option<object>;
DEFINE FIELD OVERWRITE stats.* ON user TYPE option<number>;
DEFINE INDEX OVERWRITE email_idx ON user FIELDS email UNIQUE;

-- lobby: one record per active game lobby
DEFINE TABLE OVERWRITE lobby SCHEMAFULL
  PERMISSIONS FULL
;
-- admin: the lobby owner
DEFINE FIELD OVERWRITE admin ON lobby TYPE object;
DEFINE FIELD OVERWRITE admin.uid ON lobby TYPE string;
DEFINE FIELD OVERWRITE admin.name ON lobby TYPE string;
DEFINE FIELD OVERWRITE timeCreated ON lobby TYPE datetime;

-- users: keyed by player display name → { name, uid }
DEFINE FIELD OVERWRITE users ON lobby TYPE object;
DEFINE FIELD OVERWRITE users.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE users.*.name ON lobby TYPE string;
DEFINE FIELD OVERWRITE users.*.uid ON lobby TYPE string;

-- game state
DEFINE FIELD OVERWRITE game ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.state ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.phase ON lobby TYPE option<string>;
DEFINE FIELD OVERWRITE game.timeCreated ON lobby TYPE option<string>;
DEFINE FIELD OVERWRITE game.players ON lobby TYPE option<array<string>>;
DEFINE FIELD OVERWRITE game.roles ON lobby TYPE option<array<string>>;
DEFINE FIELD OVERWRITE game.options ON lobby TYPE option<object>;
DEFINE FIELD OVERWRITE game.options.* ON lobby TYPE any;

-- game.missions: array of mission objects
DEFINE FIELD OVERWRITE game.missions ON lobby TYPE option<array>;
DEFINE FIELD OVERWRITE game.missions.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.missions.*.state ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.missions.*.teamSize ON lobby TYPE int;
DEFINE FIELD OVERWRITE game.missions.*.failsRequired ON lobby TYPE int;
DEFINE FIELD OVERWRITE game.missions.*.team ON lobby TYPE array<string>;
DEFINE FIELD OVERWRITE game.missions.*.numFails ON lobby TYPE option<int>;
DEFINE FIELD OVERWRITE game.missions.*.proposals ON lobby TYPE array;
DEFINE FIELD OVERWRITE game.missions.*.proposals.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.missions.*.proposals.*.proposer ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.missions.*.proposals.*.state ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.missions.*.proposals.*.team ON lobby TYPE array<string>;
DEFINE FIELD OVERWRITE game.missions.*.proposals.*.votes ON lobby TYPE array<string>;

-- game.outcome: set when game ends
DEFINE FIELD OVERWRITE game.outcome ON lobby TYPE option<object>;
DEFINE FIELD OVERWRITE game.outcome.state ON lobby TYPE option<string>;
DEFINE FIELD OVERWRITE game.outcome.message ON lobby TYPE option<string>;
DEFINE FIELD OVERWRITE game.outcome.assassinated ON lobby TYPE option<string|null>;
DEFINE FIELD OVERWRITE game.outcome.roles ON lobby TYPE option<array>;
DEFINE FIELD OVERWRITE game.outcome.roles.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.outcome.roles.*.name ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.outcome.roles.*.role ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.outcome.roles.*.assassin ON lobby TYPE bool;
DEFINE FIELD OVERWRITE game.outcome.votes ON lobby TYPE option<array>;
DEFINE FIELD OVERWRITE game.outcome.votes.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.outcome.votes.*.* ON lobby TYPE bool;

-- secret_state: server-only game secrets (roles, votes)
DEFINE TABLE OVERWRITE secret_state SCHEMAFULL
  PERMISSIONS
    FOR select, create, update, delete FULL
;
DEFINE FIELD OVERWRITE lobby ON secret_state TYPE record<lobby>;

-- secret_state.roles: keyed by player name → role assignment
DEFINE FIELD OVERWRITE roles ON secret_state TYPE object;
DEFINE FIELD OVERWRITE roles.* ON secret_state TYPE object;
DEFINE FIELD OVERWRITE roles.*.name ON secret_state TYPE string;
DEFINE FIELD OVERWRITE roles.*.role ON secret_state TYPE string;
DEFINE FIELD OVERWRITE roles.*.assassin ON secret_state TYPE bool;
DEFINE FIELD OVERWRITE roles.*.team ON secret_state TYPE string;
DEFINE FIELD OVERWRITE roles.*.sees ON secret_state TYPE array<string>;

-- secret_state.votes: { mission: [{ playerName: bool }], proposal: { playerName: bool } }
DEFINE FIELD OVERWRITE votes ON secret_state TYPE object;
DEFINE FIELD OVERWRITE votes.mission ON secret_state TYPE array;
DEFINE FIELD OVERWRITE votes.mission.* ON secret_state TYPE object;
DEFINE FIELD OVERWRITE votes.mission.*.* ON secret_state TYPE bool;
DEFINE FIELD OVERWRITE votes.proposal ON secret_state TYPE object;
DEFINE FIELD OVERWRITE votes.proposal.* ON secret_state TYPE bool;

-- player_role: one record per player in an active game (client-visible role info)
DEFINE TABLE OVERWRITE player_role SCHEMAFULL
  PERMISSIONS
    FOR select WHERE user = $auth.id
    FOR create, update, delete FULL
;
DEFINE FIELD OVERWRITE lobby ON player_role TYPE record<lobby>;
DEFINE FIELD OVERWRITE user ON player_role TYPE record<user>;
DEFINE FIELD OVERWRITE uid ON player_role TYPE string;
DEFINE FIELD OVERWRITE name ON player_role TYPE string;
DEFINE FIELD OVERWRITE role ON player_role TYPE string;
DEFINE FIELD OVERWRITE assassin ON player_role TYPE bool;
DEFINE FIELD OVERWRITE sees ON player_role TYPE array<string>;
DEFINE INDEX OVERWRITE player_role_lookup ON player_role FIELDS lobby, user UNIQUE;

-- game_log: completed game records
DEFINE TABLE OVERWRITE game_log SCHEMAFULL
  PERMISSIONS
    FOR select FULL
    FOR create, update, delete FULL
;
DEFINE FIELD OVERWRITE timeCreated ON game_log TYPE option<string>;
DEFINE FIELD OVERWRITE timeFinished ON game_log TYPE datetime;
DEFINE FIELD OVERWRITE options ON game_log TYPE option<object>;
DEFINE FIELD OVERWRITE options.* ON game_log TYPE any;

-- game_log.missions: same structure as lobby.game.missions
DEFINE FIELD OVERWRITE missions ON game_log TYPE array;
DEFINE FIELD OVERWRITE missions.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE missions.*.state ON game_log TYPE string;
DEFINE FIELD OVERWRITE missions.*.teamSize ON game_log TYPE int;
DEFINE FIELD OVERWRITE missions.*.failsRequired ON game_log TYPE int;
DEFINE FIELD OVERWRITE missions.*.team ON game_log TYPE array<string>;
DEFINE FIELD OVERWRITE missions.*.numFails ON game_log TYPE option<int>;
DEFINE FIELD OVERWRITE missions.*.proposals ON game_log TYPE array;
DEFINE FIELD OVERWRITE missions.*.proposals.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE missions.*.proposals.*.proposer ON game_log TYPE string;
DEFINE FIELD OVERWRITE missions.*.proposals.*.state ON game_log TYPE string;
DEFINE FIELD OVERWRITE missions.*.proposals.*.team ON game_log TYPE array<string>;
DEFINE FIELD OVERWRITE missions.*.proposals.*.votes ON game_log TYPE array<string>;

-- game_log.outcome: same structure as lobby.game.outcome
DEFINE FIELD OVERWRITE outcome ON game_log TYPE object;
DEFINE FIELD OVERWRITE outcome.state ON game_log TYPE string;
DEFINE FIELD OVERWRITE outcome.message ON game_log TYPE string;
DEFINE FIELD OVERWRITE outcome.assassinated ON game_log TYPE option<string|null>;
DEFINE FIELD OVERWRITE outcome.roles ON game_log TYPE array;
DEFINE FIELD OVERWRITE outcome.roles.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE outcome.roles.*.name ON game_log TYPE string;
DEFINE FIELD OVERWRITE outcome.roles.*.role ON game_log TYPE string;
DEFINE FIELD OVERWRITE outcome.roles.*.assassin ON game_log TYPE bool;
DEFINE FIELD OVERWRITE outcome.votes ON game_log TYPE array;
DEFINE FIELD OVERWRITE outcome.votes.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE outcome.votes.*.* ON game_log TYPE bool;

-- game_log.players: array of { name, uid } for each player
DEFINE FIELD OVERWRITE players ON game_log TYPE array;
DEFINE FIELD OVERWRITE players.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE players.*.name ON game_log TYPE string;
DEFINE FIELD OVERWRITE players.*.uid ON game_log TYPE record<user>;

-- stats: global game statistics
DEFINE TABLE OVERWRITE stats SCHEMAFULL
  PERMISSIONS
    FOR select FULL
    FOR create, update, delete FULL
;
DEFINE FIELD OVERWRITE games ON stats TYPE option<int>;
DEFINE FIELD OVERWRITE good_wins ON stats TYPE option<int>;
DEFINE FIELD OVERWRITE playtimeSeconds ON stats TYPE option<float>;

-- ============ HELPER FUNCTIONS ============

-- Replace element at index in array (immutable)
DEFINE FUNCTION OVERWRITE fn::array_set($arr: array, $idx: int, $val: any) {
  RETURN array::concat(
    array::concat(array::slice($arr, 0, $idx), [$val]),
    array::slice($arr, $idx + 1)
  );
} PERMISSIONS FULL;

-- Recursively filter out entries where key == target (helper for object_set)
DEFINE FUNCTION OVERWRITE fn::filter_entries_ne($entries: array, $key: string) {
  IF array::len($entries) == 0 { RETURN []; };
  LET $first = $entries[0];
  LET $rest = array::slice($entries, 1);
  IF $first[0] == $key {
    RETURN fn::filter_entries_ne($rest, $key);
  } ELSE {
    RETURN array::concat([$first], fn::filter_entries_ne($rest, $key));
  };
} PERMISSIONS FULL;

-- Set a key on an object (immutable, using recursive filter)
DEFINE FUNCTION OVERWRITE fn::object_set($obj: any, $key: string, $val: any) {
  LET $entries = object::entries($obj);
  LET $filtered = fn::filter_entries_ne($entries, $key);
  RETURN object::from_entries(array::concat($filtered, [[$key, $val]]));
} PERMISSIONS FULL;

-- Returns the full ROLES array (mirrors common/avalonlib.ts)
DEFINE FUNCTION OVERWRITE fn::roles() {
  RETURN [
    { name: 'MERLIN', team: 'good', sees: ['MORGANA', 'OBERON', 'ASSASSIN', 'EVIL MINION'], filler: false, selectable: true, assassinationPriority: 0 },
    { name: 'PERCIVAL', team: 'good', sees: ['MERLIN', 'MORGANA'], filler: false, selectable: true, assassinationPriority: 0 },
    { name: 'LOYAL FOLLOWER', team: 'good', sees: [], filler: true, selectable: false, assassinationPriority: 0 },
    { name: 'MORGANA', team: 'evil', sees: ['MORDRED', 'ASSASSIN', 'EVIL MINION'], filler: false, selectable: true, assassinationPriority: 2 },
    { name: 'MORDRED', team: 'evil', sees: ['MORGANA', 'ASSASSIN', 'EVIL MINION'], filler: false, selectable: true, assassinationPriority: 3 },
    { name: 'OBERON', team: 'evil', sees: [], filler: false, selectable: true, assassinationPriority: 1 },
    { name: 'EVIL MINION', team: 'evil', sees: ['MORGANA', 'MORDRED', 'ASSASSIN', 'EVIL MINION'], filler: true, selectable: false, assassinationPriority: 4 },
    { name: 'ASSASSIN', team: 'evil', sees: ['MORGANA', 'MORDRED', 'EVIL MINION'], filler: false, selectable: true, assassinationPriority: 10 }
  ];
} PERMISSIONS FULL;

-- Number of evil players for a given game size
DEFINE FUNCTION OVERWRITE fn::num_evil($n: int) {
  IF $n == 5 OR $n == 6 { RETURN 2; };
  IF $n == 7 OR $n == 8 OR $n == 9 { RETURN 3; };
  IF $n == 10 { RETURN 4; };
  THROW "Invalid game size";
} PERMISSIONS FULL;

-- Name validation
DEFINE FUNCTION OVERWRITE fn::validate_name($name: string) {
  IF $name == '__proto__' OR $name == 'constructor' OR $name == 'prototype' {
    THROW "Invalid player name";
  };
  IF !string::is_alphanum($name) OR $name != string::uppercase($name) OR string::len($name) == 0 {
    THROW "Invalid username: must be uppercase letters only";
  };
  LET $role_names = fn::roles().map(|$r| $r.name);
  IF $role_names CONTAINS $name {
    THROW "Invalid username: cannot be a role name";
  };
  RETURN true;
} PERMISSIONS FULL;

-- Build missions array for a given player list
DEFINE FUNCTION OVERWRITE fn::make_missions($player_list: array) {
  LET $n = array::len($player_list);
  LET $sizes = IF $n == 5 { [2, 3, 2, 3, 3] }
    ELSE IF $n == 6 { [2, 3, 4, 3, 4] }
    ELSE IF $n == 7 { [2, 3, 3, 4, 4] }
    ELSE IF $n == 8 { [3, 4, 4, 5, 5] }
    ELSE IF $n == 9 { [3, 4, 4, 5, 5] }
    ELSE IF $n == 10 { [3, 4, 4, 5, 5] }
    ELSE { THROW "Invalid player count for missions"; }
  ;

  -- Pick random first proposer then advance by 1
  LET $rand_idx = rand::int(0, $n - 1);
  LET $first_proposer = $player_list[($rand_idx + 1) % $n];

  LET $missions = $sizes.map(|$sz| {
    state: 'PENDING',
    teamSize: $sz,
    failsRequired: 1,
    team: [],
    proposals: []
  });

  -- Mission 4 (index 3) needs 2 fails for 7+ players
  IF $n >= 7 {
    LET $m3 = $missions[3];
    LET $missions = fn::array_set($missions, 3, { state: $m3.state, teamSize: $m3.teamSize, failsRequired: 2, team: $m3.team, proposals: $m3.proposals });
  };

  -- Set first proposal on first mission
  LET $m0 = $missions[0];
  LET $missions = fn::array_set($missions, 0, {
    state: $m0.state,
    teamSize: $m0.teamSize,
    failsRequired: $m0.failsRequired,
    team: $m0.team,
    proposals: [{ proposer: $first_proposer, state: 'PENDING', team: [], votes: [] }]
  });

  RETURN $missions;
} PERMISSIONS FULL;

-- Next proposal template (round-robin proposer)
DEFINE FUNCTION OVERWRITE fn::proposal_template($current_proposer: string, $player_list: array) {
  LET $idx = array::find_index($player_list, $current_proposer);
  LET $next = $player_list[($idx + 1) % array::len($player_list)];
  RETURN { proposer: $next, state: 'PENDING', team: <array<string>>[], votes: <array<string>>[] };
} PERMISSIONS FULL;

-- Filter roles keeping only those whose name is in the allowed array (recursive)
DEFINE FUNCTION OVERWRITE fn::filter_roles_by_selected($roles: array, $allowed: array) {
  IF array::len($roles) == 0 { RETURN []; };
  LET $first = $roles[0];
  LET $rest = array::slice($roles, 1);
  IF $allowed CONTAINS $first.name {
    RETURN array::concat([$first], fn::filter_roles_by_selected($rest, $allowed));
  } ELSE {
    RETURN fn::filter_roles_by_selected($rest, $allowed);
  };
} PERMISSIONS FULL;

-- Zip players with roles: special first, then filler (recursive)
DEFINE FUNCTION OVERWRITE fn::zip_player_roles($players: array, $special: array, $filler: any) {
  IF array::len($players) == 0 { RETURN []; };
  LET $player = $players[0];
  LET $rest_players = array::slice($players, 1);
  LET $role = IF array::len($special) > 0 { $special[0] } ELSE { $filler };
  LET $rest_special = IF array::len($special) > 0 { array::slice($special, 1) } ELSE { [] };
  RETURN array::concat(
    [{ name: $player, role: $role }],
    fn::zip_player_roles($rest_players, $rest_special, $filler)
  );
} PERMISSIONS FULL;

-- Find the assignment with highest assassinationPriority (recursive)
DEFINE FUNCTION OVERWRITE fn::find_assassin_name($assignments: array, $best_name: any, $best_priority: int) {
  IF array::len($assignments) == 0 { RETURN $best_name; };
  LET $first = $assignments[0];
  LET $rest = array::slice($assignments, 1);
  LET $prio = $first.role.assassinationPriority ?? 0;
  IF $prio > $best_priority {
    RETURN fn::find_assassin_name($rest, $first.name, $prio);
  } ELSE {
    RETURN fn::find_assassin_name($rest, $best_name, $best_priority);
  };
} PERMISSIONS FULL;

-- Find players matching specific role names (for "sees" computation, recursive)
DEFINE FUNCTION OVERWRITE fn::find_seen_players($sees_roles: array, $all_assignments: array, $exclude: string) {
  IF array::len($sees_roles) == 0 { RETURN []; };
  LET $target_role = $sees_roles[0];
  LET $rest_roles = array::slice($sees_roles, 1);
  LET $found = fn::find_players_with_role($all_assignments, $target_role, $exclude);
  RETURN array::concat($found, fn::find_seen_players($rest_roles, $all_assignments, $exclude));
} PERMISSIONS FULL;

-- Find all players with a given role name, excluding one player (recursive)
DEFINE FUNCTION OVERWRITE fn::find_players_with_role($assignments: array, $role_name: string, $exclude: string) {
  IF array::len($assignments) == 0 { RETURN []; };
  LET $first = $assignments[0];
  LET $rest = array::slice($assignments, 1);
  IF $first.role.name == $role_name AND $first.name != $exclude {
    RETURN array::concat([$first.name], fn::find_players_with_role($rest, $role_name, $exclude));
  } ELSE {
    RETURN fn::find_players_with_role($rest, $role_name, $exclude);
  };
} PERMISSIONS FULL;

-- Build final result entries from assignments (recursive)
DEFINE FUNCTION OVERWRITE fn::build_role_entries($assignments: array, $all_assignments: array, $assassin_name: any) {
  IF array::len($assignments) == 0 { RETURN []; };
  LET $a = $assignments[0];
  LET $rest = array::slice($assignments, 1);
  LET $seen = array::shuffle(fn::find_seen_players($a.role.sees, $all_assignments, $a.name));
  LET $is_assassin = $a.name == $assassin_name;
  LET $entry = [$a.name, {
    name: $a.name,
    role: $a.role.name,
    assassin: $is_assassin,
    team: $a.role.team,
    sees: $seen
  }];
  RETURN array::concat([$entry], fn::build_role_entries($rest, $all_assignments, $assassin_name));
} PERMISSIONS FULL;

-- Assign roles to players
DEFINE FUNCTION OVERWRITE fn::assign_roles($player_list: array, $selected_roles: array) {
  LET $all_roles = fn::roles();
  LET $shuffled = array::shuffle($player_list);
  LET $num_evil = fn::num_evil(array::len($shuffled));
  LET $evil_players = array::slice($shuffled, 0, $num_evil);
  LET $good_players = array::slice($shuffled, $num_evil);

  -- Get team roles (literal comparisons — closures work)
  LET $evil_roles = $all_roles.filter(|$r| $r.team == 'evil');
  LET $good_roles = $all_roles.filter(|$r| $r.team == 'good');

  -- Filter selected roles (recursive — closures can't access outer vars)
  LET $evil_special = fn::filter_roles_by_selected($evil_roles, $selected_roles);
  LET $evil_filler = $evil_roles.find(|$r| $r.filler == true);
  LET $good_special = fn::filter_roles_by_selected($good_roles, $selected_roles);
  LET $good_filler = $good_roles.find(|$r| $r.filler == true);

  -- Build assignments (recursive zip)
  LET $evil_assignments = fn::zip_player_roles($evil_players, $evil_special, $evil_filler);
  LET $good_assignments = fn::zip_player_roles($good_players, $good_special, $good_filler);
  LET $all_assignments = array::concat($evil_assignments, $good_assignments);

  -- Find assassin (only if MERLIN is selected)
  LET $assassin_name = IF $selected_roles CONTAINS 'MERLIN' {
    fn::find_assassin_name($evil_assignments, NONE, -1)
  } ELSE { NONE };

  -- Build result entries with sees + assassin (recursive)
  LET $result_entries = fn::build_role_entries($all_assignments, $all_assignments, $assassin_name);

  RETURN object::from_entries($result_entries);
} PERMISSIONS FULL;

-- Find element in array where element.name == $target (recursive, closures can't access outer vars)
DEFINE FUNCTION OVERWRITE fn::find_by_name($arr: array, $target: string) {
  IF array::len($arr) == 0 { RETURN NONE; };
  LET $first = $arr[0];
  IF $first.name == $target { RETURN $first; };
  RETURN fn::find_by_name(array::slice($arr, 1), $target);
} PERMISSIONS FULL;

-- Compute stats for a completed game and update global + user stats
DEFINE FUNCTION OVERWRITE fn::compute_and_combine_stats(
  $outcome_state: string,
  $outcome_roles: array,
  $players: array,
  $time_created: option<string>,
  $time_finished: string
) {
  LET $all_roles = fn::roles();

  -- Global stats
  LET $playtime = IF $time_created != NONE AND $time_created != '' {
    (time::now() - <datetime>$time_created) / 1s
  } ELSE {
    0.0
  };

  -- Upsert global stats
  LET $existing = (SELECT * FROM stats WHERE id = stats:global);
  IF array::len($existing) > 0 {
    UPDATE stats SET
      games = (games ?? 0) + 1,
      good_wins = (good_wins ?? 0) + (IF $outcome_state == 'GOOD_WIN' { 1 } ELSE { 0 }),
      playtimeSeconds = (playtimeSeconds ?? 0) + $playtime
    WHERE id = stats:global;
  } ELSE {
    CREATE stats SET
      id = stats:global,
      games = 1,
      good_wins = IF $outcome_state == 'GOOD_WIN' { 1 } ELSE { 0 },
      playtimeSeconds = $playtime;
  };

  -- Per-user stats
  FOR $player IN $players {
    LET $uid = $player.uid;
    LET $role_entry = fn::find_by_name($outcome_roles, $player.name);
    LET $role_name = IF $role_entry != NONE { $role_entry.role } ELSE { NONE };
    LET $role_obj = IF $role_name != NONE { fn::find_by_name($all_roles, $role_name) } ELSE { NONE };
    LET $team = IF $role_obj != NONE { $role_obj.team } ELSE { NONE };

    LET $is_good = $team == 'good';
    LET $won = IF $is_good { $outcome_state == 'GOOD_WIN' } ELSE { $outcome_state != 'GOOD_WIN' };

    UPDATE type::record('user', $uid) SET
      stats.games = (stats.games ?? 0) + 1,
      stats.good = (stats.good ?? 0) + (IF $is_good { 1 } ELSE { 0 }),
      stats.evil = (stats.evil ?? 0) + (IF $is_good { 0 } ELSE { 1 }),
      stats.wins = (stats.wins ?? 0) + (IF $won { 1 } ELSE { 0 }),
      stats.good_wins = (stats.good_wins ?? 0) + (IF $is_good AND $won { 1 } ELSE { 0 }),
      stats.evil_wins = (stats.evil_wins ?? 0) + (IF !$is_good AND $won { 1 } ELSE { 0 }),
      stats.playtimeSeconds = (stats.playtimeSeconds ?? 0) + $playtime;
  };
} PERMISSIONS FULL;

-- Build log_players array recursively (closures can't access outer objects)
DEFINE FUNCTION OVERWRITE fn::build_log_players($names: array, $users: any) {
  IF array::len($names) == 0 { RETURN []; };
  LET $n = $names[0];
  LET $rest = array::slice($names, 1);
  LET $entry = { name: $n, uid: type::record('user', $users[$n].uid) };
  RETURN array::concat([$entry], fn::build_log_players($rest, $users));
} PERMISSIONS FULL;

-- End a game: update lobby, cleanup secrets, create log, compute stats
DEFINE FUNCTION OVERWRITE fn::end_game(
  $lobby_id: string,
  $state: string,
  $message: string,
  $assassinated: option<string>,
  $game: object,
  $secret_roles: option<array>,
  $mission_votes: array
) {
  -- Build outcome
  LET $outcome = {
    state: $state,
    message: $message,
    assassinated: $assassinated ?? NONE,
    roles: $secret_roles ?? [],
    votes: $mission_votes
  };

  LET $lobby_rec = type::record('lobby', $lobby_id);
  LET $users = (SELECT users FROM ONLY $lobby_rec).users;
  LET $player_names = $game.players ?? [];

  -- Delete player_role and secret_state for this lobby
  DELETE player_role WHERE lobby = $lobby_rec;
  DELETE secret_state WHERE lobby = $lobby_rec;

  IF $state != 'CANCELED' {
    LET $log_name = ($game.timeCreated ?? time::format(time::now(), "%+")) + '_' + $lobby_id;
    LET $log_players = fn::build_log_players($player_names, $users);

    CREATE type::record('game_log', $log_name) SET
      missions = $game.missions ?? [],
      outcome = $outcome,
      players = $log_players,
      options = $game.options ?? NONE,
      timeCreated = $game.timeCreated ?? NONE,
      timeFinished = time::now();

    -- Update user logs
    FOR $pname IN $player_names {
      LET $puid = $users[$pname].uid;
      UPDATE type::record('user', $puid) SET
        logs = array::union(logs ?? [], [type::record('game_log', $log_name)]);
    };

    -- Compute stats
    fn::compute_and_combine_stats(
      $state,
      $secret_roles ?? [],
      $log_players,
      $game.timeCreated,
      time::format(time::now(), "%+")
    );
  };

  -- Update lobby game state
  UPDATE $lobby_rec SET game = {
    state: 'ENDED',
    phase: $game.phase,
    timeCreated: $game.timeCreated,
    missions: $game.missions,
    players: $game.players,
    roles: $game.roles,
    options: $game.options,
    outcome: $outcome
  };
} PERMISSIONS FULL;

-- ============ MAIN GAME FUNCTIONS ============

-- Login: update lastActive, clean stale lobby refs
DEFINE FUNCTION OVERWRITE fn::login($email: any) {
  LET $uid = record::id($auth.id);
  LET $user = (SELECT * FROM ONLY $auth.id);
  IF $user == NONE {
    THROW "User not found";
  };

  -- Check if user's lobby still exists
  IF $user.lobby != NONE {
    LET $lobby_exists = (SELECT id FROM lobby WHERE id = type::record('lobby', $user.lobby));
    IF array::len($lobby_exists) == 0 {
      UPDATE $auth.id SET lobby = NONE;
    };
  };

  UPDATE $auth.id SET lastActive = time::now();
} PERMISSIONS FULL;

-- Create a new lobby
DEFINE FUNCTION OVERWRITE fn::create_lobby($name: string) {
  fn::validate_name($name);
  LET $uid = record::id($auth.id);
  LET $user = (SELECT * FROM ONLY $auth.id);

  IF $user == NONE { THROW "User not found"; };

  -- If user is already in a lobby, return that
  IF $user.lobby != NONE {
    UPDATE $auth.id SET lastActive = time::now();
    RETURN { lobby: $user.lobby, name: $user.name };
  };

  -- Generate random 3-char lobby ID
  LET $chars = 'ABCDEFGHJKLMNPQRSTVWXYZ';
  LET $i1 = rand::int(0, 22);
  LET $i2 = rand::int(0, 22);
  LET $i3 = rand::int(0, 22);
  LET $c1 = string::slice($chars, $i1, $i1 + 1);
  LET $c2 = string::slice($chars, $i2, $i2 + 1);
  LET $c3 = string::slice($chars, $i3, $i3 + 1);
  LET $lobby_name = string::concat($c1, $c2, $c3);

  -- Check if lobby already exists, retry with different name if so
  LET $existing = (SELECT id FROM lobby WHERE id = type::record('lobby', $lobby_name));
  IF array::len($existing) > 0 {
    LET $j1 = rand::int(0, 22);
    LET $j2 = rand::int(0, 22);
    LET $j3 = rand::int(0, 22);
    LET $lobby_name = string::concat(
      string::slice($chars, $j1, $j1 + 1),
      string::slice($chars, $j2, $j2 + 1),
      string::slice($chars, $j3, $j3 + 1)
    );
  };

  -- Update user
  UPDATE $auth.id SET lobby = $lobby_name, name = $name;

  -- Create lobby
  LET $init_users = object::from_entries([[$name, { name: $name, uid: $uid }]]);
  CREATE type::record('lobby', $lobby_name) SET
    admin = { uid: $uid, name: $name },
    timeCreated = time::now(),
    users = $init_users,
    game = { state: 'INIT' };

  RETURN { lobby: $lobby_name, name: $name };
} PERMISSIONS FULL;

-- Join an existing lobby
DEFINE FUNCTION OVERWRITE fn::join_lobby($name: string, $lobby: string) {
  fn::validate_name($name);
  LET $uid = record::id($auth.id);
  LET $user = (SELECT * FROM ONLY $auth.id);
  IF $user == NONE { THROW "User not found"; };

  -- If user already in a lobby, return that
  IF $user.lobby != NONE {
    RETURN { lobby: $user.lobby, name: $user.name };
  };

  LET $lobby_rec = type::record('lobby', $lobby);
  LET $lobby_doc = (SELECT * FROM ONLY $lobby_rec);
  IF $lobby_doc == NONE { THROW "Lobby does not exist"; };

  IF $lobby_doc.users[$name] != NONE {
    THROW "Name taken";
  };

  IF $lobby_doc.game.state == 'ACTIVE' {
    THROW "Cannot join while game is in progress";
  };

  -- Add user to lobby
  UPDATE $lobby_rec SET users[$name] = { name: $name, uid: $uid };

  -- Update user record
  UPDATE $auth.id SET name = $name, lobby = $lobby, lastActive = time::now();

  RETURN { lobby: $lobby, name: $name };
} PERMISSIONS FULL;

-- Leave the current lobby
DEFINE FUNCTION OVERWRITE fn::leave_lobby($lobby: string) {
  LET $uid = record::id($auth.id);
  LET $user = (SELECT * FROM ONLY $auth.id);
  IF $user == NONE { THROW "User not found"; };
  LET $my_name = $user.name;

  LET $lobby_rec = type::record('lobby', $lobby);
  LET $lobby_doc = (SELECT * FROM ONLY $lobby_rec);
  IF $lobby_doc == NONE { THROW "Lobby does not exist"; };

  -- If game is active, cancel it
  IF $lobby_doc.game.state == 'ACTIVE' {
    LET $secret = (SELECT * FROM secret_state WHERE lobby = $lobby_rec LIMIT 1);
    LET $secret_doc = $secret[0];
    LET $secret_roles_arr = IF $secret_doc != NONE {
      object::values($secret_doc.roles).map(|$r| { name: $r.name, role: $r.role, assassin: $r.assassin })
    } ELSE { [] };
    LET $mission_votes = IF $secret_doc != NONE { $secret_doc.votes.mission ?? [] } ELSE { [] };

    fn::end_game(
      $lobby,
      'CANCELED',
      string::concat($my_name, ' left the game'),
      NONE,
      $lobby_doc.game,
      $secret_roles_arr,
      $mission_votes
    );
  };

  -- Remove user from lobby
  UPDATE $lobby_rec SET users[$my_name] = NONE;
  LET $updated_users = (SELECT users FROM ONLY $lobby_rec).users;

  -- Clear user's lobby
  UPDATE $auth.id SET lobby = NONE, lastActive = time::now();

  -- Handle admin handoff
  IF $lobby_doc.admin.uid == $uid {
    LET $remaining = object::keys($updated_users);
    IF array::len($remaining) == 0 {
      DELETE $lobby_rec;
    } ELSE {
      LET $new_admin_name = $remaining[0];
      LET $new_admin = $updated_users[$new_admin_name];
      UPDATE $lobby_rec SET admin = { uid: $new_admin.uid, name: $new_admin.name };
    };
  };
} PERMISSIONS FULL;

-- Kick a player from the lobby (admin only)
DEFINE FUNCTION OVERWRITE fn::kick_player($lobby: string, $name: string) {
  LET $uid = record::id($auth.id);
  LET $lobby_rec = type::record('lobby', $lobby);
  LET $lobby_doc = (SELECT * FROM ONLY $lobby_rec);
  IF $lobby_doc == NONE { THROW "Lobby does not exist"; };

  IF $lobby_doc.admin.uid != $uid { THROW "Not lobby admin"; };
  IF $lobby_doc.game.state == 'ACTIVE' { THROW "Cancel game first"; };

  LET $target = $lobby_doc.users[$name];
  IF $target == NONE { THROW "No such user"; };
  IF $target.uid == $uid { THROW "Cannot kick yourself"; };

  -- Clear kicked user's lobby
  UPDATE type::record('user', $target.uid) SET lobby = NONE;

  -- Remove from lobby
  UPDATE $lobby_rec SET users[$name] = NONE;
} PERMISSIONS FULL;

-- Start a new game
DEFINE FUNCTION OVERWRITE fn::start_game(
  $lobby: string,
  $player_list: array,
  $roles: array,
  $options: any
) {
  LET $uid = record::id($auth.id);
  LET $lobby_rec = type::record('lobby', $lobby);
  LET $lobby_doc = (SELECT * FROM ONLY $lobby_rec);
  IF $lobby_doc == NONE { THROW "Lobby does not exist"; };

  IF $lobby_doc.admin.uid != $uid { THROW "Not lobby admin"; };
  IF $lobby_doc.game.state == 'ACTIVE' { THROW "Game already in progress"; };

  -- Validate player list
  LET $n = array::len($player_list);
  IF $n < 5 OR $n > 10 { THROW "Bad player list: need 5-10 players"; };

  LET $lobby_user_keys = object::keys($lobby_doc.users);
  IF $n != array::len($lobby_user_keys) {
    THROW "Player list does not match lobby users";
  };
  FOR $pname IN $player_list {
    IF $lobby_doc.users[$pname] == NONE {
      THROW string::concat("Player not in lobby: ", $pname);
    };
  };

  -- Validate roles
  LET $all_role_names = fn::roles().map(|$r| $r.name);
  FOR $r IN $roles {
    IF !($all_role_names CONTAINS $r) {
      THROW string::concat("Bad role: ", $r);
    };
  };

  -- Assign roles
  LET $assigned = fn::assign_roles($player_list, $roles);
  LET $now = time::format(time::now(), "%+");

  -- Build game state
  LET $missions = fn::make_missions($player_list);

  UPDATE $lobby_rec SET game = {
    state: 'ACTIVE',
    phase: 'TEAM_PROPOSAL',
    timeCreated: $now,
    missions: $missions,
    players: $player_list,
    roles: object::values($assigned).map(|$r| $r.role),
    options: $options ?? {}
  };

  -- Create secret state
  CREATE secret_state SET
    lobby = $lobby_rec,
    roles = $assigned,
    votes = { mission: [], proposal: {} };

  -- Create player_role records
  FOR $role_entry IN object::values($assigned) {
    LET $player_uid = $lobby_doc.users[$role_entry.name].uid;
    CREATE player_role SET
      lobby = $lobby_rec,
      user = type::record('user', $player_uid),
      uid = $player_uid,
      name = $role_entry.name,
      role = $role_entry.role,
      assassin = $role_entry.assassin,
      sees = $role_entry.sees;
  };
} PERMISSIONS FULL;

-- Cancel an active game
DEFINE FUNCTION OVERWRITE fn::cancel_game($lobby: string, $name: string) {
  LET $uid = record::id($auth.id);
  LET $lobby_rec = type::record('lobby', $lobby);
  LET $lobby_doc = (SELECT * FROM ONLY $lobby_rec);
  IF $lobby_doc == NONE { THROW "Lobby does not exist"; };
  IF $lobby_doc.game.state != 'ACTIVE' { THROW "Game state not active"; };

  IF $lobby_doc.users[$name] == NONE OR $lobby_doc.users[$name].uid != $uid {
    THROW "You are not who you say you are";
  };

  LET $secret = (SELECT * FROM secret_state WHERE lobby = $lobby_rec LIMIT 1);
  LET $secret_doc = $secret[0];
  LET $secret_roles_arr = IF $secret_doc != NONE {
    object::values($secret_doc.roles).map(|$r| { name: $r.name, role: $r.role, assassin: $r.assassin })
  } ELSE { [] };
  LET $mission_votes = IF $secret_doc != NONE { $secret_doc.votes.mission ?? [] } ELSE { [] };

  fn::end_game(
    $lobby,
    'CANCELED',
    string::concat('Canceled by ', $name),
    NONE,
    $lobby_doc.game,
    $secret_roles_arr,
    $mission_votes
  );
} PERMISSIONS FULL;

-- Propose a team for a mission
DEFINE FUNCTION OVERWRITE fn::propose_team(
  $lobby: string,
  $mission: int,
  $proposal: int,
  $team: array
) {
  LET $uid = record::id($auth.id);
  LET $lobby_rec = type::record('lobby', $lobby);
  LET $lobby_doc = (SELECT * FROM ONLY $lobby_rec);
  IF $lobby_doc == NONE { THROW "Lobby does not exist"; };

  LET $game = $lobby_doc.game;
  IF $game.state != 'ACTIVE' { THROW "Game state not active"; };
  IF $game.phase != 'TEAM_PROPOSAL' { THROW "Wrong game phase"; };

  LET $missions = $game.missions;
  IF $mission >= array::len($missions) { THROW "Mission not found"; };
  LET $m = $missions[$mission];
  IF $m.state != 'PENDING' { THROW "Mission not pending"; };

  IF $proposal >= array::len($m.proposals) { THROW "Proposal not found"; };
  LET $p = $m.proposals[$proposal];
  IF $p.state != 'PENDING' { THROW "Proposal not pending"; };

  -- Verify proposer
  LET $proposer_uid = $lobby_doc.users[$p.proposer].uid;
  IF $uid != $proposer_uid { THROW "You are not the proposer"; };

  -- Deduplicate team
  LET $unique_team = array::distinct($team);
  IF array::len($unique_team) != $m.teamSize {
    THROW string::concat("Bad team size. Need ", <string>$m.teamSize);
  };
  FOR $t IN $unique_team {
    IF !($game.players CONTAINS $t) {
      THROW string::concat("Bad team member: ", $t);
    };
  };

  -- Update proposal with team and change phase
  LET $new_proposals = fn::array_set($m.proposals, $proposal, { proposer: $p.proposer, state: 'PENDING', team: $unique_team, votes: $p.votes });
  LET $new_missions = fn::array_set($missions, $mission, {
    state: $m.state, teamSize: $m.teamSize, failsRequired: $m.failsRequired,
    team: $m.team, numFails: $m.numFails, proposals: $new_proposals
  });

  UPDATE $lobby_rec SET
    game.phase = 'PROPOSAL_VOTE',
    game.missions = $new_missions;
} PERMISSIONS FULL;

-- Vote on a team proposal
DEFINE FUNCTION OVERWRITE fn::vote_team(
  $lobby: string,
  $mission: int,
  $proposal: int,
  $name: string,
  $vote: bool
) {
  LET $uid = record::id($auth.id);
  LET $lobby_rec = type::record('lobby', $lobby);
  LET $lobby_doc = (SELECT * FROM ONLY $lobby_rec);
  IF $lobby_doc == NONE { THROW "Lobby does not exist"; };

  LET $game = $lobby_doc.game;
  IF $game.state != 'ACTIVE' { THROW "Game state not active"; };
  IF $game.phase != 'PROPOSAL_VOTE' { THROW "Wrong game phase"; };

  LET $missions = $game.missions;
  IF $mission >= array::len($missions) { THROW "Mission not found"; };
  LET $m = $missions[$mission];
  IF $m.state != 'PENDING' { THROW "Mission not pending"; };
  IF $proposal >= array::len($m.proposals) { THROW "Proposal not found"; };
  LET $p = $m.proposals[$proposal];
  IF $p.state != 'PENDING' { THROW "Proposal not pending"; };

  -- Verify identity
  IF $lobby_doc.users[$name] == NONE OR $lobby_doc.users[$name].uid != $uid {
    THROW "You are not who you say you are";
  };

  -- Record public vote (name in votes list means they voted)
  LET $pub_votes = $p.votes;
  IF !($pub_votes CONTAINS $name) {
    LET $pub_votes = array::push($pub_votes, $name);
  };

  -- Record secret vote
  LET $secret = (SELECT * FROM secret_state WHERE lobby = $lobby_rec LIMIT 1);
  LET $secret_doc = $secret[0];
  IF $secret_doc == NONE { THROW "Secret state not found"; };

  LET $new_proposal_votes = fn::object_set($secret_doc.votes.proposal, $name, $vote);

  -- Update proposal votes in missions
  LET $new_proposals = fn::array_set($m.proposals, $proposal, { proposer: $p.proposer, state: $p.state, team: $p.team, votes: $pub_votes });
  LET $new_missions = fn::array_set($missions, $mission, {
    state: $m.state, teamSize: $m.teamSize, failsRequired: $m.failsRequired,
    team: $m.team, numFails: $m.numFails, proposals: $new_proposals
  });

  -- Check if all players have voted
  LET $num_voted = array::len(object::keys($new_proposal_votes));
  LET $num_players = array::len($game.players);

  IF $num_voted >= $num_players {
    -- Resolve the proposal
    LET $approvers = object::entries($new_proposal_votes).filter(|$e| $e[1] == true).map(|$e| $e[0]);

    LET $threshold = math::floor($num_players / 2) + 1;

    IF array::len($approvers) < $threshold {
      -- REJECTED
      LET $rej_proposals = fn::array_set($m.proposals, $proposal, { proposer: $p.proposer, state: 'REJECTED', team: $p.team, votes: $approvers });

      IF $proposal == 4 {
        -- 5th rejection = evil wins
        LET $rej_missions = fn::array_set($missions, $mission, {
          state: $m.state, teamSize: $m.teamSize, failsRequired: $m.failsRequired,
          team: $m.team, numFails: $m.numFails, proposals: $rej_proposals
        });
        LET $secret_roles_arr = object::values($secret_doc.roles).map(|$r| { name: $r.name, role: $r.role, assassin: $r.assassin });
        UPDATE $lobby_rec SET game.missions = $rej_missions;
        fn::end_game($lobby, 'EVIL_WIN', 'Five team proposals in a row rejected', NONE,
          (SELECT game FROM ONLY $lobby_rec).game, $secret_roles_arr, $secret_doc.votes.mission ?? []);
        UPDATE $secret_doc.id SET votes.proposal = $new_proposal_votes;
        RETURN NONE;
      } ELSE {
        -- Next proposal
        LET $next_proposal = fn::proposal_template($p.proposer, $game.players);
        LET $rej_proposals_with_next = array::push($rej_proposals, $next_proposal);
        LET $rej_missions = fn::array_set($missions, $mission, {
          state: $m.state, teamSize: $m.teamSize, failsRequired: $m.failsRequired,
          team: $m.team, numFails: $m.numFails, proposals: $rej_proposals_with_next
        });
        UPDATE $lobby_rec SET game.phase = 'TEAM_PROPOSAL', game.missions = $rej_missions;
        UPDATE $secret_doc.id SET votes.proposal = {};
        RETURN NONE;
      };
    } ELSE {
      -- APPROVED
      LET $app_proposals = fn::array_set($m.proposals, $proposal, { proposer: $p.proposer, state: 'APPROVED', team: $p.team, votes: $approvers });
      LET $app_missions = fn::array_set($missions, $mission, {
        state: $m.state, teamSize: $m.teamSize, failsRequired: $m.failsRequired,
        team: $m.team, numFails: $m.numFails, proposals: $app_proposals
      });
      UPDATE $lobby_rec SET game.phase = 'MISSION_VOTE', game.missions = $app_missions;
      UPDATE $secret_doc.id SET votes.proposal = {}, votes.mission = array::push($secret_doc.votes.mission, {});
      RETURN NONE;
    };
  } ELSE {
    -- Not all voted yet, just persist
    UPDATE $lobby_rec SET game.missions = $new_missions;
    UPDATE $secret_doc.id SET votes.proposal = $new_proposal_votes;
  };
} PERMISSIONS FULL;

-- Vote on a mission (success/fail)
DEFINE FUNCTION OVERWRITE fn::do_mission(
  $lobby: string,
  $mission: int,
  $proposal: int,
  $name: string,
  $vote: bool
) {
  LET $uid = record::id($auth.id);
  LET $lobby_rec = type::record('lobby', $lobby);
  LET $lobby_doc = (SELECT * FROM ONLY $lobby_rec);
  IF $lobby_doc == NONE { THROW "Lobby does not exist"; };

  LET $game = $lobby_doc.game;
  IF $game.state != 'ACTIVE' { THROW "Game state not active"; };
  IF $game.phase != 'MISSION_VOTE' { THROW "Wrong game phase"; };

  LET $missions = $game.missions;
  IF $mission >= array::len($missions) { THROW "Mission not found"; };
  LET $m = $missions[$mission];
  IF $m.state != 'PENDING' { THROW "Mission not pending"; };
  IF $proposal >= array::len($m.proposals) { THROW "Proposal not found"; };
  LET $p = $m.proposals[$proposal];
  IF $p.state != 'APPROVED' { THROW "Proposal not approved"; };

  -- Verify identity
  IF $lobby_doc.users[$name] == NONE OR $lobby_doc.users[$name].uid != $uid {
    THROW "You are not who you say you are";
  };

  LET $secret = (SELECT * FROM secret_state WHERE lobby = $lobby_rec LIMIT 1);
  LET $secret_doc = $secret[0];
  IF $secret_doc == NONE { THROW "Secret state not found"; };

  -- Good players cannot fail. If good player tries to fail, force success.
  LET $actual_vote = IF $vote == false AND $secret_doc.roles[$name].team != 'evil' { true } ELSE { $vote };

  -- Track who has voted on the mission
  LET $team = IF !($m.team CONTAINS $name) { array::push($m.team, $name) } ELSE { $m.team };

  -- Record secret mission vote (immutable pattern)
  LET $sec_mission_votes = $secret_doc.votes.mission ?? [];
  LET $existing_mission_votes = $sec_mission_votes[$mission] ?? {};
  LET $new_mission_entry = fn::object_set($existing_mission_votes, $name, $actual_vote);
  LET $new_sec_mission_votes = fn::array_set($sec_mission_votes, $mission, $new_mission_entry);

  -- Update mission with team tracking
  LET $new_missions = fn::array_set($missions, $mission, {
    state: $m.state, teamSize: $m.teamSize, failsRequired: $m.failsRequired,
    team: $team, numFails: $m.numFails, proposals: $m.proposals
  });

  -- Check if all team members have voted
  LET $num_voted = array::len(object::keys($new_mission_entry));

  IF $num_voted >= $m.teamSize {
    -- Resolve mission
    LET $num_fails = array::len(object::values($new_mission_entry).filter(|$v| $v == false));

    LET $mission_state = IF $num_fails < $m.failsRequired { 'SUCCESS' } ELSE { 'FAIL' };
    LET $resolved_missions = fn::array_set($missions, $mission, {
      state: $mission_state, teamSize: $m.teamSize, failsRequired: $m.failsRequired,
      team: $p.team, numFails: $num_fails, proposals: $m.proposals
    });

    -- Count missions
    LET $failed = array::len($resolved_missions.filter(|$mi| $mi.state == 'FAIL'));
    LET $succeeded = array::len($resolved_missions.filter(|$mi| $mi.state == 'SUCCESS'));

    LET $secret_roles_arr = object::values($secret_doc.roles).map(|$r| { name: $r.name, role: $r.role, assassin: $r.assassin });

    IF $failed == 3 {
      UPDATE $lobby_rec SET game.missions = $resolved_missions;
      UPDATE $secret_doc.id SET votes.mission = $new_sec_mission_votes;
      fn::end_game($lobby, 'EVIL_WIN', 'Three failed missions', NONE,
        (SELECT game FROM ONLY $lobby_rec).game, $secret_roles_arr, $new_sec_mission_votes);
      RETURN NONE;
    } ELSE IF $succeeded == 3 {
      IF $game.roles CONTAINS 'MERLIN' {
        -- Assassination phase
        UPDATE $lobby_rec SET game.phase = 'ASSASSINATION', game.missions = $resolved_missions;
        UPDATE $secret_doc.id SET votes.mission = $new_sec_mission_votes;
        RETURN NONE;
      } ELSE {
        UPDATE $lobby_rec SET game.missions = $resolved_missions;
        UPDATE $secret_doc.id SET votes.mission = $new_sec_mission_votes;
        fn::end_game($lobby, 'GOOD_WIN', 'Three missions succeeded', NONE,
          (SELECT game FROM ONLY $lobby_rec).game, $secret_roles_arr, $new_sec_mission_votes);
        RETURN NONE;
      };
    } ELSE {
      -- Next mission
      LET $next_mi = $mission + 1;
      LET $next_mission = $resolved_missions[$next_mi];
      LET $next_proposal = fn::proposal_template($p.proposer, $game.players);
      LET $next_proposals = array::push($next_mission.proposals, $next_proposal);
      LET $final_missions = fn::array_set($resolved_missions, $next_mi, {
        state: $next_mission.state, teamSize: $next_mission.teamSize,
        failsRequired: $next_mission.failsRequired, team: $next_mission.team,
        numFails: $next_mission.numFails, proposals: $next_proposals
      });
      UPDATE $lobby_rec SET game.phase = 'TEAM_PROPOSAL', game.missions = $final_missions;
      UPDATE $secret_doc.id SET votes.mission = $new_sec_mission_votes;
      RETURN NONE;
    };
  } ELSE {
    -- Not all voted yet
    UPDATE $lobby_rec SET game.missions = $new_missions;
    UPDATE $secret_doc.id SET votes.mission = $new_sec_mission_votes;
  };
} PERMISSIONS FULL;

-- Assassinate a player (assassin only, during ASSASSINATION phase)
DEFINE FUNCTION OVERWRITE fn::assassinate($lobby: string, $name: string, $target: string) {
  LET $uid = record::id($auth.id);
  LET $lobby_rec = type::record('lobby', $lobby);
  LET $lobby_doc = (SELECT * FROM ONLY $lobby_rec);
  IF $lobby_doc == NONE { THROW "Lobby does not exist"; };

  IF $lobby_doc.game.state != 'ACTIVE' { THROW "Game state not active"; };
  IF $lobby_doc.game.phase != 'ASSASSINATION' { THROW "Wrong game phase"; };

  -- Verify identity
  IF $lobby_doc.users[$name] == NONE OR $lobby_doc.users[$name].uid != $uid {
    THROW "You are not who you say you are";
  };

  LET $secret = (SELECT * FROM secret_state WHERE lobby = $lobby_rec LIMIT 1);
  LET $secret_doc = $secret[0];
  IF $secret_doc == NONE { THROW "Secret state not found"; };

  -- Verify assassin
  IF $secret_doc.roles[$name].assassin != true {
    THROW "You are not the assassin";
  };

  LET $secret_roles_arr = object::values($secret_doc.roles).map(|$r| { name: $r.name, role: $r.role, assassin: $r.assassin });
  LET $mission_votes = $secret_doc.votes.mission ?? [];

  IF $secret_doc.roles[$target].role == 'MERLIN' {
    fn::end_game($lobby, 'EVIL_WIN', 'Merlin assassinated', $target,
      $lobby_doc.game, $secret_roles_arr, $mission_votes);
  } ELSE {
    fn::end_game($lobby, 'GOOD_WIN', 'Three successful missions', $target,
      $lobby_doc.game, $secret_roles_arr, $mission_votes);
  };
} PERMISSIONS FULL;

-- ============ API ENDPOINTS ============
-- HTTP REST endpoints wrapping the game functions above.
-- Clients call these via fetch() with a Bearer token for auth.
-- Errors from THROW propagate as HTTP 500 with the error message in the body.

DEFINE API OVERWRITE "/login" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        RETURN { status: 200, body: fn::login($request.body.email) };
    };

DEFINE API OVERWRITE "/lobby" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        RETURN { status: 200, body: fn::create_lobby($request.body.name) };
    };

DEFINE API OVERWRITE "/lobby/:lobby/join" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        RETURN { status: 200, body: fn::join_lobby($request.body.name, $request.params.lobby) };
    };

DEFINE API OVERWRITE "/lobby/:lobby/leave" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        RETURN { status: 200, body: fn::leave_lobby($request.params.lobby) };
    };

DEFINE API OVERWRITE "/lobby/:lobby/kick" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        RETURN { status: 200, body: fn::kick_player($request.params.lobby, $request.body.name) };
    };

DEFINE API OVERWRITE "/lobby/:lobby/start" FOR post
    MIDDLEWARE api::timeout(10s)
    PERMISSIONS FULL
    THEN {
        LET $b = $request.body;
        RETURN { status: 200, body: fn::start_game($request.params.lobby, $b.player_list, $b.roles, $b.options) };
    };

DEFINE API OVERWRITE "/lobby/:lobby/cancel" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        RETURN { status: 200, body: fn::cancel_game($request.params.lobby, $request.body.name) };
    };

DEFINE API OVERWRITE "/lobby/:lobby/propose" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        LET $b = $request.body;
        RETURN { status: 200, body: fn::propose_team($request.params.lobby, $b.mission, $b.proposal, $b.team) };
    };

DEFINE API OVERWRITE "/lobby/:lobby/vote-team" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        LET $b = $request.body;
        RETURN { status: 200, body: fn::vote_team($request.params.lobby, $b.mission, $b.proposal, $b.name, $b.vote) };
    };

DEFINE API OVERWRITE "/lobby/:lobby/vote-mission" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        LET $b = $request.body;
        RETURN { status: 200, body: fn::do_mission($request.params.lobby, $b.mission, $b.proposal, $b.name, $b.vote) };
    };

DEFINE API OVERWRITE "/lobby/:lobby/assassinate" FOR post
    MIDDLEWARE api::timeout(5s)
    PERMISSIONS FULL
    THEN {
        RETURN { status: 200, body: fn::assassinate($request.params.lobby, $request.body.name, $request.body.target) };
    };
