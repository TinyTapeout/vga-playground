/*
 * Copyright (c) 2024 Uri Shaked
 * SPDX-License-Identifier: Apache-2.0
 */

`default_nettype none

module tt_um_vga_example(
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
  wire [1:0] R;
  wire [1:0] G;
  wire [1:0] B;

  // TinyVGA PMOD
  assign uo_out = {hsync, B[0], G[0], R[0], vsync, B[1], G[1], R[1]};

  // Unused outputs assigned to 0.
  assign uio_out = 0;
  assign uio_oe  = 0;

  
  wire   [9:0] x_px;
  wire   [9:0] y_px;


  wire    activevideo;
  wire    px_clk;
  assign  px_clk = clk;
  
  reg [19:0] tm;
  reg [9:0] y_prv;

  hvsync_generator hvsync_gen(
    .clk(clk),
    .reset(~rst_n),
    .hsync(hsync),
    .vsync(vsync),
    .display_on(activevideo),
    .hpos(x_px),
    .vpos(y_px)
  );

  wire [7:0] noise_value;
  
  worley_noise_generator worley_inst (
      .clk(clk),
      .x(x_px),
      .y(y_px),
      .t(tm),
      .noise(noise_value)
  );

  assign R = activevideo ? { noise_value[7], noise_value[2] } : 2'b00;
  assign G = activevideo ? { noise_value[6], noise_value[3] } : 2'b00;
  assign B = activevideo ? { noise_value[5], noise_value[4] } : 2'b00;
  
  always @(posedge clk) begin
    if (~rst_n) begin
      tm <= 0;
    end else begin
      y_prv <= y_px;
      if (y_px == 0 && y_prv != y_px) begin
          tm <= tm + 1;
      end
    end
  end
  
endmodule


module worley_noise_generator (
    input wire clk,
    input wire [9:0] x,
    input wire [9:0] y,
    input wire [19:0] t,
    output reg [7:0] noise
);

  // Define a small fixed grid of points
  reg [8:0] points_x[0:3];
  reg [8:0] points_y[0:3];


  assign points_x[0] = 100 + t;
  assign points_y[0] = 100 - t;
  assign points_x[1] = 300 - (t >> 1);
  assign points_y[1] = 200 + (t >> 1);
  assign points_x[2] = 500 + (t >> 1);
  assign points_y[2] = 400 - (t >> 4);
  assign points_x[3] = 100 - (t >> 3);
  assign points_y[3] = 500 - (t >> 2);

  wire [15:0] distance1 = (x - points_x[0]) * (x - points_x[0]) + (y - points_y[0]) * (y - points_y[0]);
  wire [15:0] distance2 = (x - points_x[1]) * (x - points_x[1]) + (y - points_y[1]) * (y - points_y[1]);
  wire [15:0] distance3 = (x - points_x[2]) * (x - points_x[2]) + (y - points_y[2]) * (y - points_y[2]);
  wire [15:0] distance4 = (x - points_x[3]) * (x - points_x[3]) + (y - points_y[3]) * (y - points_y[3]);
  wire [15:0] min_dist = 
    (distance1 < distance2) ? 
      (distance1 < distance3) ? 
        (distance1 < distance4) ? distance1 : distance4 : 
        (distance3 < distance4) ? distance3 : distance4 :
      (distance2 < distance3) ?
        (distance2 < distance4) ? distance2 : distance4 :
        (distance3 < distance4) ? distance3 : distance4;

  assign noise = ~min_dist[15:8];  // Scale down to 8-bit value
  
endmodule
