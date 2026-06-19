<?php
/**
 * WordPress integration for annotate.js
 *
 * Two ways to add it:
 *
 *  A) No code — install a "header & footer scripts" plugin (WPCode, Insert
 *     Headers and Footers, etc.) and paste this into the FOOTER box:
 *
 *       <script src="https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js"
 *               data-project="my-wp-site" defer></script>
 *
 *  B) Theme code — copy the function below into your (child) theme's
 *     functions.php, or wrap it in a small mu-plugin.
 *
 * The example below also restricts the review tools to logged-in editors so
 * your public visitors never see the toolbar. Remove the current_user_can()
 * guard to show it to everyone.
 */

function annotatejs_enqueue() {
	// Only load for users who can edit content. Delete this block to show it
	// to every visitor.
	if ( ! current_user_can( 'edit_posts' ) ) {
		return;
	}

	wp_enqueue_script(
		'annotatejs',
		'https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js',
		array(),     // no dependencies
		'1.0.1',     // version (also busts caches)
		true         // load in the footer
	);
}
add_action( 'wp_enqueue_scripts', 'annotatejs_enqueue' );

/**
 * Optional: pass configuration (project, accent color, theme) by defining
 * window.AnnotateConfig just before the script runs.
 */
function annotatejs_config() {
	if ( ! current_user_can( 'edit_posts' ) ) {
		return;
	}
	?>
	<script>
		window.AnnotateConfig = {
			project: "<?php echo esc_js( get_bloginfo( 'name' ) ); ?>",
			accent: "#6d28d9",
			theme: "auto"
		};
	</script>
	<?php
}
add_action( 'wp_print_footer_scripts', 'annotatejs_config', 9 ); // before the script
