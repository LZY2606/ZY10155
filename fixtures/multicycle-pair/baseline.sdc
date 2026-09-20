create_clock -name clk -period 10 [get_ports CLK]
set_multicycle_path 2 -setup -from [get_pins A/q] -to [get_pins B/d]
set_multicycle_path 1 -hold -from [get_pins A/q] -to [get_pins B/d]
