/*
 * Copyright (c) 2024 Renaldas Zioma
 * based on the VGA examples by Uri Shaked
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
  // increase couner every frame (vsync happens once per frame)
  reg [9:0] counter;
  always @(posedge vsync, negedge rst_n) begin
    if (~rst_n) begin
      counter <= 0;
    end else begin
      counter <= counter + 1;
    end
  end  

  // animate layers
  wire [9:0] layer_a_x = pix_x + counter*16;
  wire [9:0] layer_a_y = pix_y + counter*2;

  wire [9:0] layer_b_x = pix_x + counter*7;
  wire [9:0] layer_b_y = pix_y + counter + counter/2;

  wire [9:0] layer_c_x = pix_x + counter*4;
  wire [9:0] layer_c_y = pix_y + counter/2;

  wire [9:0] layer_d_x = pix_x + counter*2;
  wire [9:0] layer_d_y = pix_y + counter/4;

  wire [9:0] layer_e_x = pix_x + counter/2;
  wire [9:0] layer_e_y = pix_y + counter/6;

  //                    checker shape          * transparency using pixel dithering
  wire layer_a = (layer_a_x[8] ^ layer_a_y[8]) & ( pix_y[1] ^ pix_x[0]);
  wire layer_b = (layer_b_x[7] ^ layer_b_y[7]) & (~pix_y[0] ^ pix_x[1]);
  wire layer_c =  layer_c_x[6] ^ layer_c_y[6] ;
  wire layer_d =  layer_d_x[5] ^ layer_d_y[5] ;
  wire layer_e = (layer_e_x[4] ^ layer_e_y[4]) & ( pix_y[1] ^ pix_x[0]);

  wire [5:0] color_a = ~ui_in[5:0]; // color of the closest layer
  wire [5:0] color_b = color_a ^ 6'b00_10_10;
  wire [5:0] color_c = color_b & 6'b10_10_10;
  wire [5:0] color_de = color_c >> 1; // color of the two farthest layers
                                      // the layer e also using dithering to darken the color

  assign {R, G, B} =
      video_active ?
        (layer_a ? color_a :
          (layer_b ? color_b : 
            (layer_c ? color_c : 
              (layer_d ? color_de :
                (layer_e ? color_de : 6'b00_00_00))))) : 6'b00_00_00;

  

  // VGA signals
  wire hsync;
  wire vsync;
  wire [1:0] R;
  wire [1:0] G;
  wire [1:0] B;
  wire video_active;
  wire [9:0] pix_x;
  wire [9:0] pix_y;

  // TinyVGA PMOD
  assign uo_out = {hsync, B[0], G[0], R[0], vsync, B[1], G[1], R[1]};

  // Unused outputs assigned to 0.
  assign uio_out = 0;
  assign uio_oe  = 0;

  // Suppress unused signals warning
  wire _unused_ok = &{ena, ui_in, uio_in};

  hvsync_generator hvsync_gen(
    .clk(clk),
    .reset(~rst_n),
    .hsync(hsync),
    .vsync(vsync),
    .display_on(video_active),
    .hpos(pix_x),
    .vpos(pix_y)
  );

endmodule
