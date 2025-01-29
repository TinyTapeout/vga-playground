/*
 * Copyright (c) 2024 Ciro Cattuto
 * based on the VGA examples by Uri Shaked
 * and on tt07-conway-term (https://github.com/ccattuto/tt07-conway-term)
 * SPDX-License-Identifier: Apache-2.0
 */

`default_nettype none

module tt_um_gaming_pmod_demo #(
  parameter UI_IN_INDEX_LATCH = 3,
  parameter UI_IN_INDEX_CLOCK = 4,
  parameter UI_IN_INDEX_DATA  = 5
) (
  input  wire [7:0] ui_in,    // Dedicated inputs
  output wire [7:0] uo_out,   // Dedicated outputs
  input  wire [7:0] uio_in,   // IOs: Input path
  output wire [7:0] uio_out,  // IOs: Output path
  output wire [7:0] uio_oe,   // IOs: Enable path (active high: 0=input, 1=output)
  input  wire       ena,      // always 1 when the design is powered, so you can ignore it
  input  wire       clk,      // clock
  input  wire       rst_n     // reset_n - low to reset
);

  // VGA signals
  wire hsync;
  wire vsync;
  reg [1:0] R;
  reg [1:0] G;
  reg [1:0] B;
  wire video_active;
  wire [9:0] pix_x;
  wire [9:0] pix_y;

  // TinyVGA PMOD
  assign uo_out  = {hsync, B[0], G[0], R[0], vsync, B[1], G[1], R[1]};

  // Game controller buttons state
  // controller 0 has the 0th bit of each of these,
  // e.g. if up button is pressed inp_up[0] will be 1 
  // for controller 0
  // the second controller would stick that state in inp_up[1]
  // See the gaming_pmod.v file comments for more deets.
  wire [1:0] inp_b;
  wire [1:0] inp_y;
  wire [1:0] inp_select;
  wire [1:0] inp_start;
  wire [1:0] inp_up;
  wire [1:0] inp_down;
  wire [1:0] inp_left;
  wire [1:0] inp_right;
  wire [1:0] inp_a;
  wire [1:0] inp_x;
  wire [1:0] inp_l;
  wire [1:0] inp_r;
  wire [1:0] controller_present;
  

  wire [1:0] left_stripe = pix_x < 50 ? inp_left : 0;
  wire [1:0] right_stripe = pix_x >= 50 && pix_x < 100 ? inp_right : 0 ;
  wire [1:0] up_stripe = (pix_x >= 100 && pix_x < 150 ) ? inp_up : 0;
  wire [1:0] down_stripe = (pix_x >= 150 && pix_x < 200) ? inp_down : 0;
  wire [1:0] a_stripe = (pix_x >= 200 && pix_x < 250) ? inp_a : 0;
  wire [1:0] b_stripe = (pix_x >= 250 && pix_x < 300) ? inp_b : 0;
  
  hvsync_generator vga_sync_gen (
    .clk(clk),
    .reset(~rst_n),
    .hsync(hsync),
    .vsync(vsync),
    .display_on(video_active),
    .hpos(pix_x),
    .vpos(pix_y)
  );
  
  
  game_controller_pmod game_con_pmod(
    .rst_n(rst_n),
    .clk(clk),
    
    // pmod input pins
    .pmod_latch(ui_in[UI_IN_INDEX_LATCH]),
    .pmod_clk(ui_in[UI_IN_INDEX_CLOCK]),
    .pmod_data(ui_in[UI_IN_INDEX_DATA]),

    // output state for both controllers
    .b(inp_b),
    .y(inp_y),
    .select(inp_select),
    .start(inp_start),
    .up(inp_up),
    .down(inp_down),
    .left(inp_left),
    .right(inp_right),
    .a(inp_a),
    .x(inp_x),
    .l(inp_l),
    .r(inp_r),
    .is_present(controller_present)
    
  );


  // RGB output logic
  always @(posedge clk) begin
    if (~rst_n || ~video_active) begin
      R <= 0;
      G <= 0;
      B <= 0;
    end else begin
      R <= (left_stripe | down_stripe | b_stripe);
      G <= (right_stripe | down_stripe | a_stripe);
      B <= (up_stripe | a_stripe | b_stripe);
    end
  end

endmodule



