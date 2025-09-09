<?php
/**
 * Plugin Name: EdgeViper User Bets
 * Description: Adds a REST endpoint and "My Bets" tab for logged-in users, merging Google Sheets data with Discord bot stakes.
 * Version:     1.12.1
 * Author:      Edge Viper
 */

// Exit if accessed directly
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

// Preview bypass key
if ( ! defined( 'EV_API_KEY' ) ) {
    define( 'EV_API_KEY', 'b7f4c9e2-3a1d-4e6f-8b5c-9d0e1f2a3b4d' );
}
// Bot service constants (set in wp-config.php)
if ( defined( 'BOT_API_BASE_URL' ) && ! defined( 'EV_BOT_API_BASE_URL' ) ) {
    define( 'EV_BOT_API_BASE_URL', BOT_API_BASE_URL );
}
if ( defined( 'BOT_WEBHOOK_KEY' ) && ! defined( 'EV_BOT_WEBHOOK_KEY' ) ) {
    define( 'EV_BOT_WEBHOOK_KEY', BOT_WEBHOOK_KEY );
}

/**
 * Register REST route
 */
add_action( 'rest_api_init', 'ev_register_user_bets_route' );
function ev_register_user_bets_route() {
    register_rest_route( 'ev/v1', '/user-bets', [
        'methods'             => WP_REST_Server::READABLE,
        'callback'            => 'ev_handle_user_bets',
        'permission_callback' => 'ev_permission_user_bets',
    ] );
}

/**
 * Permission check for REST
 */
function ev_permission_user_bets( $request ) {
    if ( is_user_logged_in() ) {
        return true;
    }
    $key = $request->get_param( 'key' );
    return ( $key === EV_API_KEY );
}

/**
 * REST callback: fetch sheet + stakes, merge, compute stats
 */
function ev_handle_user_bets( $request ) {
    // Ensure logged in
    if ( ! is_user_logged_in() ) {
        return new WP_Error( 'ev_not_logged_in', 'You must be logged in to view bets.', [ 'status' => 401 ] );
    }

    $user_id    = get_current_user_id();
    $discord_id = get_user_meta( $user_id, 'mepr_discord_id', true );
    if ( empty( $discord_id ) ) {
        return [ 'bets' => [], 'stats' => [] ];
    }

    // Fetch Google Sheet rows
    $rows = ev_fetch_master_bets();

    // Fetch user stakes from Bot API
    if ( ! defined( 'EV_BOT_API_BASE_URL' ) || ! defined( 'EV_BOT_WEBHOOK_KEY' ) ) {
        return [ 'bets' => [], 'stats' => [] ];
    }
    $api_url  = EV_BOT_API_BASE_URL . '/api/user-stakes?discord_id=' . rawurlencode( $discord_id );
    $response = wp_remote_get( $api_url, [
        'headers' => [ 'Authorization' => 'Bearer ' . EV_BOT_WEBHOOK_KEY ],
        'timeout' => 15,
    ] );

    $stakes_map = $notes_map = $odds_override_map = [];
    if ( ! is_wp_error( $response ) ) {
        $code = wp_remote_retrieve_response_code( $response );
        $body = wp_remote_retrieve_body( $response );
        if ( $code === 200 ) {
            $data = json_decode( $body, true );
            if ( is_array( $data ) ) {
                $stakes_map        = array_column( $data, 'stake',         'bet_id' );
                $notes_map         = array_column( $data, 'notes',         'bet_id' );
                $odds_override_map = array_column( $data, 'odds_override', 'bet_id' );
            }
        }
    }

    // Merge bets with stakes
    $bets = [];
    foreach ( $rows as $r ) {
        $bet_id = str_replace( ',', '', $r['bet_id'] ?? '' );
        if ( ! $bet_id ) {
            continue;
        }

        // only include if user has logged a stake
        if ( isset( $stakes_map[ $bet_id ] ) ) {
            $stake = floatval( $stakes_map[ $bet_id ] );
            $res   = strtoupper( $r['result'] ?? '' );

            // pull override if present & numeric
            $override = ( isset( $odds_override_map[ $bet_id ] ) && $odds_override_map[ $bet_id ] !== '' && is_numeric( $odds_override_map[ $bet_id ] ) )
                ? floatval( $odds_override_map[ $bet_id ] )
                : null;

            // decide which odds to display
            $sheet_odds   = floatval( $r['odds'] );
            $display_odds = ( $override !== null ) ? $override : $sheet_odds;

            // profit uses **displayed** odds (what the user actually got if overridden)
            if ( $res === 'W' ) {
                $profit = ( $display_odds * $stake ) - $stake;
            } elseif ( $res === 'L' ) {
                $profit = - $stake;
            } else {
                $profit = null; // pending
            }

            $bets[] = [
                'bet_id'        => $bet_id,
                'date'          => $r['date'],
                'bookie'        => $r['bookie'],
                'event'         => $r['event'],
                'bet'           => $r['bet'],

                // resolved odds for UI and P/L
                'odds'          => $display_odds,
                // also expose raw override for transparency in the frontend (optional to show)
                'odds_override' => $override,

                'stake'         => $stake,
                'profit'        => $profit,
                'result'        => $res,
                'settle_date'   => $r['settle_date'],
                'notes'         => $notes_map[ $bet_id ] ?? '',
            ];
        }
    }

    // Fetch initial bankroll and enforce minimum £500
    $initial_bankroll = floatval( get_user_meta( $user_id, 'mepr_bankroll', true ) );
    if ( $initial_bankroll < 500 ) {
        $initial_bankroll = 500;
    }

    // Calculate stats
    $total_staked      = 0;
    $total_profit      = 0;
    foreach ( $bets as $b ) {
        if ( in_array( $b['result'], [ 'W', 'L', 'P' ], true ) ) {
            $total_staked += $b['stake'];
        }
        if ( in_array( $b['result'], [ 'W', 'L' ], true ) && $b['profit'] !== null ) {
            $total_profit += $b['profit'];
        }
    }
    $roi               = $total_staked > 0 ? ( $total_profit / $total_staked ) * 100 : 0;
    $bankroll_current  = $initial_bankroll + $total_profit;
    $bankroll_growth   = $initial_bankroll > 0 ? ( ( $bankroll_current - $initial_bankroll ) / $initial_bankroll ) * 100 : 0;

    $stats = [
        'total_staked'       => round( $total_staked, 2 ),
        'total_profit'       => round( $total_profit, 2 ),
        'roi'                => number_format( $roi, 2 ) . '%',
        'bankroll_growth_pc' => number_format( $bankroll_growth, 2 ) . '%',
        'bankroll_initial'   => round( $initial_bankroll, 2 ),
        'bankroll_current'   => round( $bankroll_current, 2 ),
    ];

    return [
        'bets'  => $bets,
        'stats' => $stats,
    ];
}

/**
 * Fetch and map Google Sheet rows without array_combine()
 */
function ev_fetch_master_bets() {
    require_once __DIR__ . '/vendor/autoload.php';

    $client = new Google_Client();
    $client->setAuthConfig( defined('EV_GCP_SA') ? EV_GCP_SA : getenv('GOOGLE_APPLICATION_CREDENTIALS') );
    $client->addScope( Google_Service_Sheets::SPREADSHEETS_READONLY );
    $service  = new Google_Service_Sheets( $client );
    $response = $service->spreadsheets_values->get(
        '1r6GHthZCMqj4IV9ZOSCupobwzOaaoN5W5qtvpiCrJBY',
        'MasterBets!A:W'
    );
    $values = $response->getValues();
    if ( empty( $values ) ) {
        return [];
    }

    // Drop the header row
    array_shift( $values );

    $out = [];
    foreach ( $values as $row ) {
        $out[] = [
            'date'        => $row[0]  ?? '',
            'bookie'      => $row[1]  ?? '',
            'event'       => $row[3]  ?? '',
            'bet'         => $row[4]  ?? '',
            'odds'        => isset( $row[6] ) ? floatval( $row[6] ) : 0,
            'probability' => isset( $row[7] ) ? floatval( $row[7] ) : 0,
            'result'      => $row[8]  ?? '',
            'settle_date' => $row[5]  ?? '',
            'bet_id'      => isset( $row[22] )
                ? str_replace( ',', '', $row[22] )
                : '',
        ];
    }

    return $out;
}

/**
 * Enqueue front-end assets (only on My Bets)
 */
add_action( 'wp_enqueue_scripts', function() {
    // Only when logged in AND on the MemberPress “My Bets” page
    if ( ! ( is_user_logged_in()
             && is_page( 'account' )
             && isset( $_GET['action'] )
             && $_GET['action'] === 'my-bets' ) ) {
        return;
    }

    // DataTables core
    wp_enqueue_style( 'dt-css', 'https://cdn.datatables.net/1.13.6/css/jquery.dataTables.min.css' );
    wp_enqueue_script( 'dt-js', 'https://cdn.datatables.net/1.13.6/js/jquery.dataTables.min.js', [ 'jquery' ], null, true );

    // DataTables Responsive (only here)
    wp_enqueue_style( 'dt-responsive-css', 'https://cdn.datatables.net/responsive/2.5.0/css/responsive.dataTables.min.css', [ 'dt-css' ], '2.5.0' );
    wp_enqueue_script( 'dt-responsive-js', 'https://cdn.datatables.net/responsive/2.5.0/js/dataTables.responsive.min.js', [ 'dt-js' ], '2.5.0', true );

    // Chart.js for cumulative profit chart
    wp_enqueue_script( 'chartjs', 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js', [], '4.4.0', true );

    // Plugin script
    wp_enqueue_script(
        'ev-bets-js',
        plugins_url( 'js/ev-user-bets.js', __FILE__ ),
        [ 'jquery', 'dt-js', 'dt-responsive-js', 'chartjs' ],
        '1.12.1',
        true
    );
    wp_localize_script( 'ev-bets-js', 'EV_BetsData', [
        'restUrl' => rest_url( 'ev/v1/user-bets' ),
        'nonce'   => wp_create_nonce( 'wp_rest' ),
    ] );
}, 20 );

/**
 * Shortcode to render table container
 */
add_shortcode( 'ev_user_bets', function() {
    if ( ! is_user_logged_in() ) {
        return '<p>Please log in to view your bets.</p>';
    }
return '
<table id="ev-bets-table" class="results-table display" width="100%">
  <thead><tr>
    <th>ID</th>
    <th>Date</th>
    <th>Bookie</th>
    <th>Event</th>
    <th>Bet</th>
    <th>Odds</th>
    <th>Stake</th>
    <th>W/L</th>
    <th>P/L</th>
    <th>Settle Date</th>
	<th>Notes</th>
  </tr></thead>
  <tbody></tbody>
</table>';
} );

/**
 * Add "My Bets" tab in MemberPress
 */
add_action( 'mepr_account_nav', function() {
    $active = ( isset( $_GET['action'] ) && $_GET['action'] === 'my-bets' ) ? 'mepr-active-nav-tab' : '';
    echo '<span class="mepr-nav-item my-bets ' . esc_attr( $active ) . '">';
    echo '<a href="' . esc_url( home_url( '/account/?action=my-bets' ) ) . '">My Bets</a>';
    echo '</span>';
} );
add_action( 'mepr_account_nav_content', function( $action ) {
    if ( $action === 'my-bets' ) {
        echo '<h2>My Bets</h2>' . do_shortcode( '[ev_user_bets]' );
    }
} );

// 1) Register the new endpoint
add_action( 'rest_api_init', function() {
  register_rest_route( 'ev/v1', '/hist-stats', [
    'methods'             => 'GET',
    'callback'            => 'ev_hist_stats_cb',
    'permission_callback' => '__return_true',
    'args'                => [
      'mode' => [
        'required'          => true,
        'validate_callback' => function( $v ) {
          return in_array( $v, [ 'kelly', 'flat', 'stw' ], true );
        },
      ],
      // just defaults—remove sanitize_callback
      'bankroll'   => [ 'required'=>false, 'default'=>1000 ],
      'kelly_pct'  => [ 'required'=>false, 'default'=>20   ],
      'flat_stake' => [ 'required'=>false, 'default'=>20   ],
      'stw_amount' => [ 'required'=>false, 'default'=>60  ],
    ],
  ] );
} );

// 2) Handler that pulls from "Filtered to Web" and calculates
function ev_hist_stats_cb( WP_REST_Request $req ) {
  // Grab params
  $mode      = $req->get_param('mode');
  $bankroll  = max(0, $req->get_param('bankroll'));
  $kelly_pct = min(1, max(0, $req->get_param('kelly_pct')/100));
  $flat_st   = max(0, $req->get_param('flat_stake'));
  $stw_amt   = max(0, $req->get_param('stw_amount'));

  // Load Google Client
  require_once __DIR__ . '/vendor/autoload.php';
  $client = new Google_Client();
  $client->setAuthConfig( defined('EV_GCP_SA') ? EV_GCP_SA : getenv('GOOGLE_APPLICATION_CREDENTIALS') );
  $client->addScope( Google_Service_Sheets::SPREADSHEETS_READONLY );
  $svc  = new Google_Service_Sheets( $client );
  $resp = $svc->spreadsheets_values->get(
    '1r6GHthZCMqj4IV9ZOSCupobwzOaaoN5W5qtvpiCrJBY',
    'Filtered to Web!A:Z'
  );
  $rows = $resp->getValues() ?: [];
  if(count($rows) < 2) {
    return rest_ensure_response([
      'total_staked'=>0,'total_profit'=>0,'roi'=>'0.00%','bankroll_growth'=>'0.00%'
    ]);
  }
  array_shift($rows); // drop header

  $total_staked = 0;
  $total_profit = 0;
  $current_bank = $bankroll;

foreach( $rows as $r ) {
  $odds   = floatval( $r[6] );
  $prob   = floatval( $r[20] );
  $res    = strtoupper( $r[8] );
  if( $prob > 1 ) $prob /= 100;

  // — apply your D/T flag from column M (index 12) —
  $flag = strtoupper( $r[12] );
  if( $flag === 'D' ) {
	$eff_odds = (($odds - 1) / 2) + 1;
  }
  elseif( $flag === 'T' ) {
	$eff_odds = (($odds - 1) / 3) + 1;
  }
  else {
	$eff_odds = $odds;
  }

  // — stake calculation exactly as your JS does —
  switch( $mode ) {
	case 'flat':
	  $stake = $flat_st;
	  break;
	case 'kelly':
	  $stake = floor( (( $eff_odds * $prob - 1 ) / ( $eff_odds - 1 )) 
					 * $current_bank * $kelly_pct );
	  break;
	default: // stw
	  $raw   = $stw_amt / ( $eff_odds - 1 );
	  $stake = round( $raw );
	  if( $stake * ( $eff_odds - 1 ) < $stw_amt ) {
		$stake++;
	  }
	  break;
  }

  // — profit always uses the **original** odds —
  if( $res === 'W' ) {
	$profit = ( $odds * $stake ) - $stake;
  }
  elseif( $res === 'L' ) {
	$profit = - $stake;
  }
  else {
	$profit = 0;
  }

  // tally up
  if( in_array( $res, ['W','L'], true ) ) {
	$total_staked += $stake;
	$total_profit += $profit;
	$current_bank += $profit;
  }
}

  $roi    = $total_staked>0 ? number_format($total_profit/$total_staked*100,2).'%' : '0.00%';
  $growth = $bankroll > 0
    ? number_format((($bankroll + $total_profit)/$bankroll)*100,2).'%'
    : '0.00%';

  return rest_ensure_response([
    'total_staked'   => $total_staked,
    'total_profit'   => $total_profit,
    'roi'            => $roi,
    'bankroll_growth'=> $growth,
  ]);
}

add_action( 'send_headers', function() {
  if ( is_user_logged_in()
    && isset( $_GET['action'] )
    && $_GET['action'] === 'my-bets'
  ) {
    // strip any existing Cache-Control / Expires / Pragma
    header_remove( 'Cache-Control' );
    header_remove( 'Expires' );
    header_remove( 'Pragma'    );

    // set your own cache rules — NO shared‐cache, no store, no fallback
    header( 'Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0, s-maxage=0', true );
    header( 'Pragma: no-cache', true );
    header( 'Expires: 0', true );
  }
}, 100 );