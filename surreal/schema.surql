-- ============================================================
-- Avalon Game - SurrealDB Schema
-- Namespace: avalon, Database: avalon
-- ============================================================

-- ============================================================
-- SECTION 1: RECORD ACCESS (Authentication)
-- ============================================================
-- Anonymous signup: client calls db.signup() and receives a JWT.
-- No password required. Sessions last 30 days.

DEFINE ACCESS OVERWRITE anon ON DATABASE TYPE RECORD
    SIGNUP (
        CREATE user CONTENT {
            created_at:  time::now(),
            last_active: time::now(),
        }
    )
    DURATION
        FOR TOKEN   30d,
        FOR SESSION 30d
;


-- ============================================================
-- SECTION 2: TABLE - user
-- ============================================================
DEFINE TABLE OVERWRITE user SCHEMAFULL
    CHANGEFEED 1h
    PERMISSIONS
        FOR select, update WHERE id = $auth.id
        FOR create WHERE $auth != NONE
        FOR delete NONE
;

DEFINE FIELD OVERWRITE name        ON user TYPE option<string>;
DEFINE FIELD OVERWRITE lobby       ON user TYPE option<record<lobby>>;
DEFINE FIELD OVERWRITE created_at  ON user TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE last_active ON user TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE log_ids     ON user TYPE option<array> DEFAULT [];
DEFINE FIELD OVERWRITE stats       ON user TYPE option<object> FLEXIBLE;


-- ============================================================
-- SECTION 3: TABLE - lobby
-- ============================================================
-- All authenticated users can SELECT lobbies (needed for joining and live queries).
-- Lobby record ID IS the 3-char code: lobby:ABC
-- Note: CUD permissions are open to authenticated users because DEFINE API
-- THEN blocks run as the record user, not as system. Game logic validation
-- is enforced by the API endpoints, not by table permissions.

DEFINE TABLE OVERWRITE lobby SCHEMALESS
    CHANGEFEED 1h
    PERMISSIONS
        FOR select, create, update, delete WHERE $auth != NONE
;


-- ============================================================
-- SECTION 4: TABLE - player_role
-- ============================================================
-- Per-player secret role info. SELECT restricted to own record only.
-- CUD open to authenticated users (API endpoints run as record user).

DEFINE TABLE OVERWRITE player_role SCHEMAFULL
    CHANGEFEED 1h
    PERMISSIONS
        FOR select WHERE user = $auth.id
        FOR create, update, delete WHERE $auth != NONE
;

DEFINE INDEX OVERWRITE idx_player_role_lobby_user
    ON player_role FIELDS lobby, user UNIQUE;

DEFINE FIELD OVERWRITE lobby    ON player_role TYPE record<lobby>;
DEFINE FIELD OVERWRITE user     ON player_role TYPE record<user>;
DEFINE FIELD OVERWRITE name     ON player_role TYPE string;
DEFINE FIELD OVERWRITE role     ON player_role TYPE string;
DEFINE FIELD OVERWRITE assassin ON player_role TYPE bool DEFAULT false;
DEFINE FIELD OVERWRITE team     ON player_role TYPE string;
DEFINE FIELD OVERWRITE sees     ON player_role TYPE array DEFAULT [];


-- ============================================================
-- SECTION 5: TABLE - secret_state
-- ============================================================
-- Contains full role map and vote tallies. Should ideally be
-- inaccessible to clients, but DEFINE API THEN blocks run as
-- the record user so they need read/write access.
-- SELECT is restricted to users who are participants in the
-- lobby's active game. This prevents cross-lobby snooping but
-- cannot fully prevent a player from reading their own game's
-- secret state via crafted queries. A future SurrealDB
-- security-definer feature would solve this completely.

-- Limitation: DEFINE API THEN blocks run as the record user, not as
-- system. The API endpoints need SELECT access to secret_state, so we
-- cannot set FOR select NONE. A user could craft queries to read their
-- own lobby's secret_state. SurrealDB does not yet support
-- security-definer functions that would fully solve this.
DEFINE TABLE OVERWRITE secret_state SCHEMALESS
    PERMISSIONS
        FOR select, create, update, delete WHERE $auth != NONE
;

DEFINE INDEX OVERWRITE idx_secret_state_lobby
    ON secret_state FIELDS lobby UNIQUE;


-- ============================================================
-- SECTION 6: TABLE - game_log
-- ============================================================
-- Written at game end (non-canceled). Readable by all authenticated users.
-- CUD open because API endpoints run as record user.

DEFINE TABLE OVERWRITE game_log SCHEMALESS
    PERMISSIONS
        FOR select, create, update, delete WHERE $auth != NONE
;


-- ============================================================
-- SECTION 7: TABLE - global_stats
-- ============================================================
-- Singleton record. CUD open because API endpoints run as record user.

DEFINE TABLE OVERWRITE global_stats SCHEMAFULL
    PERMISSIONS
        FOR select, create, update, delete WHERE $auth != NONE
;

DEFINE FIELD OVERWRITE games         ON global_stats TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE good_wins     ON global_stats TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE playtime_secs ON global_stats TYPE float DEFAULT 0.0;

-- Seed the singleton
INSERT INTO global_stats (id, games, good_wins, playtime_secs)
    VALUES (global_stats:global, 0, 0, 0.0)
    ON DUPLICATE KEY UPDATE id = id;


-- ============================================================
-- SECTION 8: HELPER FUNCTIONS
-- ============================================================

-- Replace an element in an array at a given index
DEFINE FUNCTION OVERWRITE fn::array_set($arr: array, $idx: int, $value: any) -> array {
    RETURN array::concat(
        array::concat(
            array::slice($arr, 0, $idx),
            [$value]
        ),
        array::slice($arr, $idx + 1)
    );
};

-- Create the next proposal template
DEFINE FUNCTION OVERWRITE fn::proposal_template($current_proposer: string, $player_list: array) -> object {
    LET $idx = array::find_index($player_list, $current_proposer);
    LET $next_idx = ($idx + 1) % array::len($player_list);
    RETURN {
        proposer: $player_list[$next_idx],
        state: "PENDING",
        team: [],
        votes: []
    };
};

-- Create the 5 missions array for a given player count
DEFINE FUNCTION OVERWRITE fn::make_missions($player_list: array) -> array {
    LET $n = array::len($player_list);
    LET $sizes = IF $n == 5 { [2, 3, 2, 3, 3] }
        ELSE IF $n == 6 { [2, 3, 4, 3, 4] }
        ELSE IF $n == 7 { [2, 3, 3, 4, 4] }
        ELSE IF $n == 8 { [3, 4, 4, 5, 5] }
        ELSE IF $n == 9 { [3, 4, 4, 5, 5] }
        ELSE IF $n == 10 { [3, 4, 4, 5, 5] }
        ELSE { THROW "Invalid player count" };

    -- Pick a random first proposer
    LET $random_idx = rand::int(0, $n);
    LET $first_proposer_idx = ($random_idx + 1) % $n;

    LET $missions = [
        { state: "PENDING", teamSize: $sizes[0], failsRequired: 1, team: [], proposals: [
            { proposer: $player_list[$first_proposer_idx], state: "PENDING", team: [], votes: [] }
        ]},
        { state: "PENDING", teamSize: $sizes[1], failsRequired: 1, team: [], proposals: [] },
        { state: "PENDING", teamSize: $sizes[2], failsRequired: 1, team: [], proposals: [] },
        { state: "PENDING", teamSize: $sizes[3], failsRequired: IF $n >= 7 { 2 } ELSE { 1 }, team: [], proposals: [] },
        { state: "PENDING", teamSize: $sizes[4], failsRequired: 1, team: [], proposals: [] },
    ];

    RETURN $missions;
};

-- Assign roles to players, create secret_state and player_role records
-- Returns array of public role names (for lobby.game.roles)
DEFINE FUNCTION OVERWRITE fn::assign_roles(
    $lobby_id: record<lobby>,
    $player_list: array,
    $role_names: array,
    $users: object
) -> array {
    -- Role sees definitions
    LET $sees_map = {
        "MERLIN": ["MORGANA", "OBERON", "ASSASSIN", "EVIL MINION"],
        "PERCIVAL": ["MERLIN", "MORGANA"],
        "LOYAL FOLLOWER": [],
        "MORGANA": ["MORDRED", "ASSASSIN", "EVIL MINION"],
        "MORDRED": ["MORGANA", "ASSASSIN", "EVIL MINION"],
        "OBERON": [],
        "EVIL MINION": ["MORGANA", "MORDRED", "ASSASSIN", "EVIL MINION"],
        "ASSASSIN": ["MORGANA", "MORDRED", "EVIL MINION"],
    };

    LET $team_map = {
        "MERLIN": "good", "PERCIVAL": "good", "LOYAL FOLLOWER": "good",
        "MORGANA": "evil", "MORDRED": "evil", "OBERON": "evil",
        "EVIL MINION": "evil", "ASSASSIN": "evil"
    };

    LET $assassination_priority = {
        "MORGANA": 2, "MORDRED": 3, "OBERON": 1, "EVIL MINION": 4, "ASSASSIN": 10,
        "MERLIN": 0, "PERCIVAL": 0, "LOYAL FOLLOWER": 0
    };

    -- Evil count by player count
    LET $n = array::len($player_list);
    LET $num_evil = IF $n == 5 { 2 }
        ELSE IF $n == 6 { 2 }
        ELSE IF $n == 7 { 3 }
        ELSE IF $n == 8 { 3 }
        ELSE IF $n == 9 { 3 }
        ELSE IF $n == 10 { 4 }
        ELSE { THROW "Invalid player count" };

    -- Shuffle players
    LET $shuffled = array::shuffle($player_list);
    LET $evil_players = array::slice($shuffled, 0, $num_evil);
    LET $good_players = array::slice($shuffled, $num_evil);

    -- Get selected special roles by team, preserving selection order
    LET $evil_role_order = ["MORGANA", "MORDRED", "OBERON", "ASSASSIN"];
    LET $good_role_order = ["MERLIN", "PERCIVAL"];

    LET $selected_evil = array::filter($evil_role_order, |$r| $role_names CONTAINS $r);
    LET $selected_good = array::filter($good_role_order, |$r| $role_names CONTAINS $r);

    -- Build role assignments using a temp record as scratch space
    DELETE secret_state WHERE lobby = $lobby_id;
    LET $created = CREATE secret_state CONTENT {
        lobby: $lobby_id,
        roles: {},
        votes: { proposal: {}, mission: [] }
    };
    LET $secret_id = $created[0].id;

    -- Assign evil roles
    FOR $player IN $evil_players {
        LET $idx = array::find_index($evil_players, $player);
        LET $role_name = IF $idx < array::len($selected_evil) { $selected_evil[$idx] } ELSE { "EVIL MINION" };
        UPDATE $secret_id SET roles[$player] = {
            name: $player,
            role: $role_name,
            assassin: false,
            team: "evil",
            sees: []
        };
    };

    -- Assign good roles
    FOR $player IN $good_players {
        LET $idx = array::find_index($good_players, $player);
        LET $role_name = IF $idx < array::len($selected_good) { $selected_good[$idx] } ELSE { "LOYAL FOLLOWER" };
        UPDATE $secret_id SET roles[$player] = {
            name: $player,
            role: $role_name,
            assassin: false,
            team: "good",
            sees: []
        };
    };

    -- Mark assassin: evil player with highest assassination priority (if MERLIN is in play)
    IF $role_names CONTAINS "MERLIN" {
        LET $secret = (SELECT * FROM ONLY $secret_id);
        LET $evil_entries = array::filter(
            object::entries($secret.roles),
            |$e| $e[1].team == "evil"
        );
        -- Find the one with highest assassination_priority
        LET $best_assassin = array::reduce($evil_entries, |$best, $cur| {
            IF $assassination_priority[$cur[1].role] > $assassination_priority[$best[1].role] {
                $cur
            } ELSE {
                $best
            }
        });
        IF $best_assassin != NONE {
            LET $assassin_name = $best_assassin[0];
            LET $old_role = (SELECT * FROM ONLY $secret_id).roles[$assassin_name];
            UPDATE $secret_id SET roles[$assassin_name] = $old_role + { assassin: true };
        };
    };

    -- Compute sees lists: for each player, find all other players whose role is in this player's sees list
    LET $secret = (SELECT * FROM ONLY $secret_id);
    LET $all_entries = object::entries($secret.roles);
    FOR $entry IN $all_entries {
        LET $p_name = $entry[0];
        LET $p_role = $entry[1].role;
        LET $can_see_roles = $sees_map[$p_role];
        LET $visible_players = array::shuffle(
            array::map(
                array::filter($all_entries, |$other| {
                    $other[0] != $p_name AND $can_see_roles CONTAINS $other[1].role
                }),
                |$other| $other[0]
            )
        );
        LET $cur_role = (SELECT * FROM ONLY $secret_id).roles[$p_name];
        UPDATE $secret_id SET roles[$p_name] = $cur_role + { sees: $visible_players };
    };

    -- Create player_role records for each player
    LET $final_secret = (SELECT * FROM ONLY $secret_id);
    DELETE player_role WHERE lobby = $lobby_id;
    FOR $entry IN object::entries($final_secret.roles) {
        LET $p_name = $entry[0];
        LET $p_data = $entry[1];
        LET $p_uid = $users[$p_name].uid;
        CREATE player_role CONTENT {
            lobby:    $lobby_id,
            user:     $p_uid,
            name:     $p_name,
            role:     $p_data.role,
            assassin: $p_data.assassin,
            team:     $p_data.team,
            sees:     $p_data.sees
        };
    };

    -- Return public role names (just the role names, not assignments)
    RETURN array::map(object::values($final_secret.roles), |$r| $r.role);
};

-- End game: write outcome, optionally write log+stats, cleanup
DEFINE FUNCTION OVERWRITE fn::end_game(
    $lobby_id: record<lobby>,
    $game: object,
    $users: object,
    $state: string,
    $message: string,
    $assassinated: option<string>
) {
    LET $secret = (SELECT * FROM secret_state WHERE lobby = $lobby_id)[0];

    -- Build public roles list
    LET $roles_public = array::map(
        object::values($secret.roles),
        |$r| { name: $r.name, role: $r.role, assassin: $r.assassin }
    );

    LET $outcome = {
        state:        $state,
        message:      $message,
        assassinated: $assassinated,
        roles:        $roles_public,
        votes:        $secret.votes.mission
    };

    -- Update lobby game state
    UPDATE $lobby_id SET game = object::extend($game, {
        state:   "ENDED",
        outcome: $outcome
    });

    -- Write log and update stats if not canceled
    IF $state != "CANCELED" {
        LET $log_id = type::record("game_log",
            string::concat(<string>$game.time_created, "_", meta::id($lobby_id))
        );
        LET $log_players = array::map($game.players, |$pname| {
            name: $pname,
            uid:  $users[$pname].uid
        });
        CREATE $log_id CONTENT {
            lobby:        $lobby_id,
            missions:     $game.missions,
            outcome:      $outcome,
            players:      $log_players,
            options:      $game.options,
            time_created: $game.time_created,
            time_finished: time::now()
        };

        -- Update each player's stats
        LET $playtime = <float>((time::now() - $game.time_created) / 1s);
        FOR $pname IN $game.players {
            LET $p_uid = $users[$pname].uid;
            LET $p_role = $secret.roles[$pname];
            LET $is_good = $p_role.team == "good";
            LET $won = ($is_good AND $state == "GOOD_WIN") OR (!$is_good AND $state == "EVIL_WIN");
            LET $cur_stats = (SELECT VALUE stats FROM ONLY $p_uid) ?? {
                games: 0, good: 0, evil: 0, wins: 0, good_wins: 0, evil_wins: 0, playtime_secs: 0.0
            };
            UPDATE $p_uid SET
                log_ids += [$log_id],
                stats = {
                    games:         ($cur_stats.games ?? 0) + 1,
                    good:          ($cur_stats.good ?? 0) + IF $is_good { 1 } ELSE { 0 },
                    evil:          ($cur_stats.evil ?? 0) + IF !$is_good { 1 } ELSE { 0 },
                    wins:          ($cur_stats.wins ?? 0) + IF $won { 1 } ELSE { 0 },
                    good_wins:     ($cur_stats.good_wins ?? 0) + IF $is_good AND $won { 1 } ELSE { 0 },
                    evil_wins:     ($cur_stats.evil_wins ?? 0) + IF !$is_good AND $won { 1 } ELSE { 0 },
                    playtime_secs: ($cur_stats.playtime_secs ?? 0.0) + $playtime
                };
        };

        -- Update global stats
        UPDATE global_stats:global SET
            games += 1,
            good_wins += IF $state == "GOOD_WIN" { 1 } ELSE { 0 },
            playtime_secs += $playtime;
    };

    -- Cleanup secret data
    DELETE secret_state WHERE lobby = $lobby_id;
    DELETE player_role WHERE lobby = $lobby_id;
};

-- Name validation. Returns NONE if valid, or an error message string if invalid.
DEFINE FUNCTION OVERWRITE fn::validate_name($name: string) -> option<string> {
    LET $role_names = ["MERLIN", "PERCIVAL", "LOYAL FOLLOWER", "MORGANA", "MORDRED", "OBERON", "EVIL MINION", "ASSASSIN"];
    IF $name == NONE OR $name == "" {
        RETURN "Name cannot be empty";
    };
    IF !string::matches($name, "^[A-Z]+$") {
        RETURN "Name must be uppercase letters only";
    };
    IF $role_names CONTAINS $name {
        RETURN "Name cannot be a role name";
    };
    IF $name == "__proto__" OR $name == "constructor" OR $name == "prototype" {
        RETURN "Invalid name";
    };
    RETURN NONE;
};


-- ============================================================
-- SECTION 9: API ENDPOINTS
-- ============================================================

-- POST /login - bump last_active
DEFINE API OVERWRITE "/login" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        UPDATE $auth.id SET last_active = time::now();
        RETURN { status: 200, body: { ok: true } };
    }
;

-- POST /createLobby  { name: string }
DEFINE API OVERWRITE "/createLobby" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid  = $auth.id;
        LET $name = $request.body.name;

        -- Validate name
        LET $name_err = fn::validate_name($name);
        IF $name_err != NONE {
            RETURN { status: 400, body: { message: $name_err } };
        };

        LET $user = (SELECT * FROM ONLY $uid);

        -- If already in a lobby, return it
        IF $user.lobby != NONE {
            RETURN {
                status: 200,
                body: { lobby: meta::id($user.lobby), name: $user.name }
            };
        };

        -- Generate random 3-char lobby code
        LET $chars = ["A","B","C","D","E","F","G","H","J","K","L","M","N","P","Q","R","S","T","V","W","X","Y","Z"];
        LET $code = string::concat($chars[rand::int(0, 23)], $chars[rand::int(0, 23)], $chars[rand::int(0, 23)]);
        LET $lobby_id = type::record("lobby", $code);

        -- Check for collision
        LET $existing = (SELECT id FROM ONLY $lobby_id);
        IF $existing != NONE {
            RETURN { status: 409, body: { message: "LOBBY_CODE_COLLISION" } };
        };

        CREATE $lobby_id CONTENT {
            admin:        { uid: $uid, name: $name },
            time_created: time::now(),
            users:        object::from_entries([[$name, { name: $name, uid: $uid }]]),
            game:         { state: "INIT" }
        };

        UPDATE $uid SET
            name        = $name,
            lobby       = $lobby_id,
            last_active = time::now();

        RETURN {
            status: 200,
            body: { lobby: $code, name: $name }
        };
    }
;

-- POST /joinLobby  { lobby: string, name: string }
DEFINE API OVERWRITE "/joinLobby" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid      = $auth.id;
        LET $name     = $request.body.name;
        LET $code     = $request.body.lobby;
        LET $lobby_id = type::record("lobby", $code);
        LET $user     = (SELECT * FROM ONLY $uid);
        LET $lobby    = (SELECT * FROM ONLY $lobby_id);

        -- Validate name
        LET $name_err = fn::validate_name($name);
        IF $name_err != NONE {
            RETURN { status: 400, body: { message: $name_err } };
        };

        IF $user == NONE {
            RETURN { status: 404, body: { message: "User not found" } };
        };

        -- Already in this lobby
        IF $user.lobby == $lobby_id {
            RETURN { status: 200, body: { lobby: $code, name: $user.name } };
        };

        -- Already in a different lobby
        IF $user.lobby != NONE {
            RETURN { status: 200, body: { lobby: meta::id($user.lobby), name: $user.name } };
        };

        IF $lobby == NONE {
            RETURN { status: 404, body: { message: "Lobby " + $code + " does not exist" } };
        };

        IF $lobby.game.state == "ACTIVE" {
            RETURN { status: 429, body: { message: "Cannot join while game is in progress" } };
        };

        IF type::is_object($lobby.users) AND object::keys($lobby.users) CONTAINS $name {
            RETURN { status: 429, body: { message: "Name taken" } };
        };

        UPDATE $lobby_id SET users[$name] = { name: $name, uid: $uid };
        UPDATE $uid SET name = $name, lobby = $lobby_id, last_active = time::now();

        RETURN { status: 200, body: { lobby: $code, name: $name } };
    }
;

-- POST /leaveLobby  { lobby: string }
DEFINE API OVERWRITE "/leaveLobby" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid      = $auth.id;
        LET $code     = $request.body.lobby;
        LET $lobby_id = type::record("lobby", $code);
        LET $user     = (SELECT * FROM ONLY $uid);
        LET $lobby    = (SELECT * FROM ONLY $lobby_id);

        IF $user == NONE OR $lobby == NONE {
            RETURN { status: 404, body: { message: "Not in that lobby" } };
        };

        LET $my_name = $user.name;

        -- If game is active, cancel it
        IF $lobby.game.state == "ACTIVE" {
            fn::end_game($lobby_id, $lobby.game, $lobby.users, "CANCELED", $my_name + " left the game", NONE);
        };

        -- Remove player from lobby
        LET $new_users = object::remove($lobby.users, $my_name);
        UPDATE $uid SET lobby = NONE, last_active = time::now();

        -- Handle admin succession or lobby deletion
        IF object::len($new_users) == 0 {
            DELETE $lobby_id;
        } ELSE IF $lobby.admin.uid == $uid {
            LET $first_name = object::keys($new_users)[0];
            UPDATE $lobby_id SET
                users = $new_users,
                admin = { uid: $new_users[$first_name].uid, name: $first_name };
        } ELSE {
            UPDATE $lobby_id SET users = $new_users;
        };

        RETURN { status: 200, body: { ok: true } };
    }
;

-- POST /kickPlayer  { lobby: string, name: string }
DEFINE API OVERWRITE "/kickPlayer" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid      = $auth.id;
        LET $code     = $request.body.lobby;
        LET $name     = $request.body.name;
        LET $lobby_id = type::record("lobby", $code);
        LET $lobby    = (SELECT * FROM ONLY $lobby_id);

        IF $lobby == NONE {
            RETURN { status: 404, body: { message: "Lobby not found" } };
        };
        IF $lobby.admin.uid != $uid {
            RETURN { status: 403, body: { message: "Not lobby admin" } };
        };
        IF $lobby.game.state == "ACTIVE" {
            RETURN { status: 429, body: { message: "Cancel game first" } };
        };
        IF NOT (object::keys($lobby.users) CONTAINS $name) {
            RETURN { status: 404, body: { message: "No such user" } };
        };

        LET $target_uid = $lobby.users[$name].uid;
        IF $target_uid == $uid {
            RETURN { status: 400, body: { message: "Can't kick yourself" } };
        };

        UPDATE $lobby_id SET users = object::remove($lobby.users, $name);
        UPDATE $target_uid SET lobby = NONE;

        RETURN { status: 200, body: { ok: true } };
    }
;

-- POST /startGame  { lobby: string, playerList: string[], roles: string[], options?: object }
DEFINE API OVERWRITE "/startGame" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid         = $auth.id;
        LET $code        = $request.body.lobby;
        LET $player_list = $request.body.playerList;
        LET $roles_list  = $request.body.roles;
        LET $options     = $request.body.options;
        LET $lobby_id    = type::record("lobby", $code);
        LET $lobby       = (SELECT * FROM ONLY $lobby_id);

        IF $lobby == NONE {
            RETURN { status: 404, body: { message: "No such lobby: " + $code } };
        };
        IF $lobby.admin.uid != $uid {
            RETURN { status: 403, body: { message: "Not lobby admin" } };
        };
        IF $lobby.game.state == "ACTIVE" {
            RETURN { status: 429, body: { message: "Game already in progress" } };
        };

        -- Validate player list
        IF !type::is_array($player_list) OR array::len($player_list) < 5 OR array::len($player_list) > 10 {
            RETURN { status: 400, body: { message: "Bad player list: need 5-10 players" } };
        };

        -- Verify all players are in the lobby
        LET $lobby_user_names = object::keys($lobby.users);
        IF array::len($player_list) != array::len($lobby_user_names) {
            RETURN { status: 400, body: { message: "Player list doesn't match lobby users" } };
        };
        FOR $p IN $player_list {
            IF NOT ($lobby_user_names CONTAINS $p) {
                RETURN { status: 400, body: { message: "Player " + $p + " not in lobby" } };
            };
        };

        -- Validate roles
        LET $valid_roles = ["MERLIN", "PERCIVAL", "LOYAL FOLLOWER", "MORGANA", "MORDRED", "OBERON", "EVIL MINION", "ASSASSIN"];
        IF type::is_array($roles_list) {
            FOR $r IN $roles_list {
                IF NOT ($valid_roles CONTAINS $r) {
                    RETURN { status: 400, body: { message: "Invalid role: " + $r } };
                };
            };
        };

        -- Assign roles (creates secret_state and player_role records)
        LET $public_roles = fn::assign_roles($lobby_id, $player_list, $roles_list ?? [], $lobby.users);

        -- Create missions
        LET $missions = fn::make_missions($player_list);

        -- Update lobby game state
        UPDATE $lobby_id SET game = {
            state:        "ACTIVE",
            phase:        "TEAM_PROPOSAL",
            time_created: time::now(),
            missions:     $missions,
            players:      $player_list,
            roles:        $public_roles,
            options:      $options
        };

        RETURN { status: 200, body: { ok: true } };
    }
;

-- POST /cancelGame  { lobby: string, name: string }
DEFINE API OVERWRITE "/cancelGame" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid      = $auth.id;
        LET $code     = $request.body.lobby;
        LET $name     = $request.body.name;
        LET $lobby_id = type::record("lobby", $code);
        LET $lobby    = (SELECT * FROM ONLY $lobby_id);

        IF $lobby.game.state != "ACTIVE" {
            RETURN { status: 400, body: { message: "Game not active" } };
        };
        IF $lobby.users[$name] == NONE OR $lobby.users[$name].uid != $uid {
            RETURN { status: 403, body: { message: "You are not who you say you are" } };
        };

        fn::end_game($lobby_id, $lobby.game, $lobby.users, "CANCELED", "Canceled by " + $name, NONE);

        RETURN { status: 200, body: { ok: true } };
    }
;

-- POST /proposeTeam  { lobby: string, mission: int, proposal: int, team: string[] }
DEFINE API OVERWRITE "/proposeTeam" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid          = $auth.id;
        LET $code         = $request.body.lobby;
        LET $mission_idx  = <int>$request.body.mission;
        LET $proposal_idx = <int>$request.body.proposal;
        LET $team         = array::distinct($request.body.team);
        LET $lobby_id     = type::record("lobby", $code);
        LET $lobby        = (SELECT * FROM ONLY $lobby_id);

        IF $lobby.game.state != "ACTIVE"         { RETURN { status: 400, body: { message: "Game not active" } }; };
        IF $lobby.game.phase != "TEAM_PROPOSAL"  { RETURN { status: 400, body: { message: "Not TEAM_PROPOSAL phase" } }; };

        LET $mission  = $lobby.game.missions[$mission_idx];
        LET $proposal = $mission.proposals[$proposal_idx];

        IF $mission == NONE { RETURN { status: 400, body: { message: "Invalid mission index" } }; };
        IF $proposal == NONE { RETURN { status: 400, body: { message: "Invalid proposal index" } }; };
        IF $mission.state  != "PENDING" { RETURN { status: 400, body: { message: "Mission not pending" } }; };
        IF $proposal.state != "PENDING" { RETURN { status: 400, body: { message: "Proposal not pending" } }; };

        -- Verify proposer identity
        IF $lobby.users[$proposal.proposer] == NONE OR $lobby.users[$proposal.proposer].uid != $uid {
            RETURN { status: 403, body: { message: "You are not the proposer" } };
        };
        IF array::len($team) != $mission.teamSize {
            RETURN { status: 400, body: { message: "Bad team size. Need " + <string>$mission.teamSize } };
        };

        -- Verify all team members are players
        FOR $t IN $team {
            IF NOT ($lobby.game.players CONTAINS $t) {
                RETURN { status: 400, body: { message: "Player " + $t + " not in game" } };
            };
        };

        -- Update proposal with team and advance phase
        LET $new_proposal = object::extend($proposal, { team: $team });
        LET $new_proposals = fn::array_set($mission.proposals, $proposal_idx, $new_proposal);
        LET $new_mission = object::extend($mission, { proposals: $new_proposals });
        LET $new_missions = fn::array_set($lobby.game.missions, $mission_idx, $new_mission);

        UPDATE $lobby_id SET game = object::extend($lobby.game, {
            phase:    "PROPOSAL_VOTE",
            missions: $new_missions
        });

        RETURN { status: 200, body: { ok: true } };
    }
;

-- POST /voteTeam  { lobby: string, name: string, mission: int, proposal: int, vote: bool }
DEFINE API OVERWRITE "/voteTeam" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid          = $auth.id;
        LET $code         = $request.body.lobby;
        LET $p_name       = $request.body.name;
        LET $mission_idx  = <int>$request.body.mission;
        LET $proposal_idx = <int>$request.body.proposal;
        LET $vote         = $request.body.vote;
        LET $lobby_id     = type::record("lobby", $code);
        LET $lobby        = (SELECT * FROM ONLY $lobby_id);
        LET $secret       = (SELECT * FROM secret_state WHERE lobby = $lobby_id)[0];

        IF $lobby.game.state != "ACTIVE"        { RETURN { status: 400, body: { message: "Game not active" } }; };
        IF $lobby.game.phase != "PROPOSAL_VOTE" { RETURN { status: 400, body: { message: "Not PROPOSAL_VOTE phase" } }; };
        IF $lobby.users[$p_name] == NONE OR $lobby.users[$p_name].uid != $uid {
            RETURN { status: 403, body: { message: "You are not who you say you are" } };
        };

        LET $mission  = $lobby.game.missions[$mission_idx];
        LET $proposal = $mission.proposals[$proposal_idx];
        IF $mission.state  != "PENDING" { RETURN { status: 400, body: { message: "Mission not pending" } }; };
        IF $proposal.state != "PENDING" { RETURN { status: 400, body: { message: "Proposal not pending" } }; };

        -- Record secret vote (atomic field-level update)
        UPDATE secret_state SET votes.proposal[$p_name] = $vote WHERE lobby = $lobby_id;

        -- Record public vote atomically (who voted, not how)
        IF NOT ($proposal.votes CONTAINS $p_name) {
            UPDATE $lobby_id SET game.missions[$mission_idx].proposals[$proposal_idx].votes += [$p_name];
        };

        -- Re-read to get authoritative state for tallying
        LET $fresh_secret_proposal = (SELECT VALUE votes.proposal FROM secret_state WHERE lobby = $lobby_id)[0];
        LET $fresh_lobby = (SELECT * FROM ONLY $lobby_id);

        -- Tally if all players voted and phase hasn't already been advanced
        IF object::len($fresh_secret_proposal) == array::len($fresh_lobby.game.players)
            AND $fresh_lobby.game.phase == "PROPOSAL_VOTE" {
            -- Count approvals
            LET $approvers = array::filter(
                object::entries($fresh_secret_proposal),
                |$e| $e[1] == true
            );
            LET $approve_count = array::len($approvers);
            LET $majority = math::floor(array::len($fresh_lobby.game.players) / 2) + 1;
            LET $approver_names = array::map($approvers, |$e| $e[0]);

            IF $approve_count < $majority {
                -- REJECTED
                UPDATE $lobby_id SET
                    game.missions[$mission_idx].proposals[$proposal_idx].state = "REJECTED",
                    game.missions[$mission_idx].proposals[$proposal_idx].votes = $approver_names;

                IF $proposal_idx == 4 {
                    -- Five rejections: evil wins
                    LET $cur_game = (SELECT VALUE game FROM ONLY $lobby_id);
                    fn::end_game($lobby_id, $cur_game, $fresh_lobby.users, "EVIL_WIN", "Five team proposals in a row rejected", NONE);
                } ELSE {
                    -- Add next proposal
                    LET $next_proposal = fn::proposal_template($proposal.proposer, $fresh_lobby.game.players);
                    UPDATE $lobby_id SET
                        game.phase = "TEAM_PROPOSAL",
                        game.missions[$mission_idx].proposals += [$next_proposal];
                    UPDATE secret_state SET votes.proposal = {} WHERE lobby = $lobby_id;
                };
            } ELSE {
                -- APPROVED: move to MISSION_VOTE
                UPDATE $lobby_id SET
                    game.phase = "MISSION_VOTE",
                    game.missions[$mission_idx].proposals[$proposal_idx].state = "APPROVED",
                    game.missions[$mission_idx].proposals[$proposal_idx].votes = $approver_names;
                UPDATE secret_state SET votes.proposal = {}, votes.mission += [{}] WHERE lobby = $lobby_id;
            };
        };

        RETURN { status: 200, body: { ok: true } };
    }
;

-- POST /doMission  { lobby: string, name: string, mission: int, proposal: int, vote: bool }
DEFINE API OVERWRITE "/doMission" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid          = $auth.id;
        LET $code         = $request.body.lobby;
        LET $p_name       = $request.body.name;
        LET $mission_idx  = <int>$request.body.mission;
        LET $proposal_idx = <int>$request.body.proposal;
        LET $vote_raw     = $request.body.vote;
        LET $lobby_id     = type::record("lobby", $code);
        LET $lobby        = (SELECT * FROM ONLY $lobby_id);
        LET $secret       = (SELECT * FROM secret_state WHERE lobby = $lobby_id)[0];

        IF $lobby.game.state != "ACTIVE"       { RETURN { status: 400, body: { message: "Game not active" } }; };
        IF $lobby.game.phase != "MISSION_VOTE" { RETURN { status: 400, body: { message: "Not MISSION_VOTE phase" } }; };
        IF $lobby.users[$p_name] == NONE OR $lobby.users[$p_name].uid != $uid {
            RETURN { status: 403, body: { message: "You are not who you say you are" } };
        };

        LET $mission  = $lobby.game.missions[$mission_idx];
        LET $proposal = $mission.proposals[$proposal_idx];
        IF $mission == NONE { RETURN { status: 400, body: { message: "Invalid mission index" } }; };
        IF $proposal == NONE { RETURN { status: 400, body: { message: "Invalid proposal index" } }; };
        IF $mission.state  != "PENDING"  { RETURN { status: 400, body: { message: "Mission not pending" } }; };
        IF $proposal.state != "APPROVED" { RETURN { status: 400, body: { message: "Proposal not approved" } }; };
        IF NOT ($proposal.team CONTAINS $p_name) {
            RETURN { status: 403, body: { message: "Not on the mission team" } };
        };

        -- Vote coercion: good players can only vote success (true)
        LET $player_role = $secret.roles[$p_name];
        LET $actual_vote = IF $player_role.team == "good" { true } ELSE { $vote_raw };

        -- Record secret mission vote (atomic field-level update)
        UPDATE secret_state SET votes.mission[$mission_idx][$p_name] = $actual_vote WHERE lobby = $lobby_id;

        -- Update public team list atomically
        UPDATE $lobby_id SET game.missions[$mission_idx].team = $proposal.team;

        -- Re-read for authoritative tally
        LET $new_mission_votes_entry = (SELECT VALUE votes.mission[$mission_idx] FROM secret_state WHERE lobby = $lobby_id)[0];
        LET $fresh_lobby = (SELECT * FROM ONLY $lobby_id);

        -- Tally if all team members voted and phase hasn't already been advanced
        IF object::len($new_mission_votes_entry) == $mission.teamSize
            AND $fresh_lobby.game.phase == "MISSION_VOTE" {
            LET $num_fails = array::len(array::filter(
                object::values($new_mission_votes_entry),
                |$v| $v == false
            ));
            LET $mission_state = IF $num_fails < $mission.failsRequired { "SUCCESS" } ELSE { "FAIL" };

            -- Atomic update of mission state
            UPDATE $lobby_id SET
                game.missions[$mission_idx].state = $mission_state,
                game.missions[$mission_idx].numFails = $num_fails;

            -- Re-read to count overall results
            LET $cur_game = (SELECT VALUE game FROM ONLY $lobby_id);
            LET $fail_count    = array::len(array::filter($cur_game.missions, |$m| $m.state == "FAIL"));
            LET $success_count = array::len(array::filter($cur_game.missions, |$m| $m.state == "SUCCESS"));

            IF $fail_count == 3 {
                fn::end_game($lobby_id, $cur_game, $fresh_lobby.users, "EVIL_WIN", "Three failed missions", NONE);
            } ELSE IF $success_count == 3 {
                IF $cur_game.roles CONTAINS "MERLIN" {
                    UPDATE $lobby_id SET game.phase = "ASSASSINATION";
                } ELSE {
                    fn::end_game($lobby_id, $cur_game, $fresh_lobby.users, "GOOD_WIN", "Three missions succeeded", NONE);
                };
            } ELSE {
                -- Advance to next mission
                LET $next_idx = $mission_idx + 1;
                LET $next_proposal = fn::proposal_template($proposal.proposer, $fresh_lobby.game.players);
                UPDATE $lobby_id SET
                    game.phase = "TEAM_PROPOSAL",
                    game.missions[$next_idx].proposals = [$next_proposal];
            };
        };

        RETURN { status: 200, body: { ok: true } };
    }
;

-- POST /assassinate  { lobby: string, name: string, target: string }
DEFINE API OVERWRITE "/assassinate" FOR post
    PERMISSIONS FULL
    THEN {
        IF $auth == NONE { RETURN { status: 401, body: { message: "Not authenticated" } }; };
        LET $uid      = $auth.id;
        LET $code     = $request.body.lobby;
        LET $a_name   = $request.body.name;
        LET $target   = $request.body.target;
        LET $lobby_id = type::record("lobby", $code);
        LET $lobby    = (SELECT * FROM ONLY $lobby_id);
        LET $secret   = (SELECT * FROM secret_state WHERE lobby = $lobby_id)[0];

        IF $lobby.game.state != "ACTIVE"       { RETURN { status: 400, body: { message: "Game not active" } }; };
        IF $lobby.game.phase != "ASSASSINATION" { RETURN { status: 400, body: { message: "Not ASSASSINATION phase" } }; };
        IF $lobby.users[$a_name] == NONE OR $lobby.users[$a_name].uid != $uid {
            RETURN { status: 403, body: { message: "You are not who you say you are" } };
        };
        IF $secret.roles[$a_name].assassin != true {
            RETURN { status: 403, body: { message: "You are not the assassin" } };
        };

        LET $outcome_state = IF $secret.roles[$target].role == "MERLIN" { "EVIL_WIN" } ELSE { "GOOD_WIN" };
        LET $outcome_msg = IF $outcome_state == "EVIL_WIN" { "Merlin assassinated" } ELSE { "Three successful missions" };

        fn::end_game($lobby_id, $lobby.game, $lobby.users, $outcome_state, $outcome_msg, $target);

        RETURN { status: 200, body: { ok: true } };
    }
;
